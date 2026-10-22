use crate::database::Database;
use crate::engine::http_downloader::DownloadJob;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;
use tracing::{error, info};

pub struct QueueManager {
    db: Database,
    client: reqwest::Client,
    active_cancels: Arc<Mutex<HashMap<String, broadcast::Sender<()>>>>,
}

impl QueueManager {
    pub fn new(db: Database) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(32)
            .build()
            .unwrap_or_default();

        Self {
            db,
            client,
            active_cancels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn start_worker_loop(self: Arc<Self>) {
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(800)).await;
                self.process_queue().await;
            }
        });
    }

    async fn process_queue(&self) {
        let settings = match self.db.load_settings() {
            Ok(s) => s,
            Err(_) => return,
        };

        let active_count = self.active_cancels.lock().len();
        if active_count >= settings.max_active_tasks {
            return;
        }

        let tasks = match self.db.list_tasks() {
            Ok(t) => t,
            Err(_) => return,
        };

        let queued_tasks: Vec<_> = tasks
            .into_iter()
            .filter(|t| t.status == "queued")
            .collect();

        let available_slots = settings.max_active_tasks.saturating_sub(active_count);
        for task in queued_tasks.into_iter().take(available_slots) {
            let task_id = task.id.clone();
            let (cancel_tx, cancel_rx) = broadcast::channel(1);

            {
                let mut cancels = self.active_cancels.lock();
                cancels.insert(task_id.clone(), cancel_tx);
            }

            let _ = self.db.update_task_status(&task_id, "downloading", None);

            let job = DownloadJob {
                task_id: task.id.clone(),
                url: task.url.clone(),
                save_path: PathBuf::from(task.save_path),
                total_bytes: task.total_bytes,
                threads: task.threads,
                db: self.db.clone(),
                cancel_rx,
            };

            let client = self.client.clone();
            let cancels_map = Arc::clone(&self.active_cancels);
            let tid = task_id.clone();

            tokio::spawn(async move {
                info!("Starting download for task: {}", tid);
                if let Err(e) = job.run(client).await {
                    error!("Download job error for {}: {}", tid, e);
                }
                cancels_map.lock().remove(&tid);
            });
        }
    }

    pub fn pause_task(&self, task_id: &str) -> bool {
        let mut cancels = self.active_cancels.lock();
        if let Some(tx) = cancels.remove(task_id) {
            let _ = tx.send(());
            let _ = self.db.update_task_status(task_id, "paused", None);
            true
        } else {
            let _ = self.db.update_task_status(task_id, "paused", None);
            false
        }
    }

    pub fn resume_task(&self, task_id: &str) -> bool {
        let _ = self.db.update_task_status(task_id, "queued", None);
        true
    }

    pub fn cancel_task(&self, task_id: &str) -> bool {
        self.pause_task(task_id);
        let _ = self.db.delete_task(task_id);
        true
    }

    pub fn is_active(&self, task_id: &str) -> bool {
        self.active_cancels.lock().contains_key(task_id)
    }
}
