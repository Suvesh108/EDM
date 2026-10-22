use crate::config::{get_db_path, AppSettings};
use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub url: String,
    pub title: String,
    pub filename: String,
    pub save_path: String,
    pub total_bytes: i64,
    pub downloaded_bytes: i64,
    pub status: String, // "queued", "downloading", "paused", "completed", "error"
    pub speed: f64,
    pub eta: i64,
    pub threads: u32,
    pub category: String,
    pub error_msg: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentInfo {
    pub task_id: String,
    pub index: u32,
    pub start_byte: i64,
    pub current_byte: i64,
    pub end_byte: i64,
    pub status: String,
}

#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    pub fn new() -> Result<Self> {
        let db_path = get_db_path();
        let conn = Connection::open(db_path)?;

        // Enable WAL mode and performance optimizations
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA temp_store = MEMORY;",
        )?;

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.init_tables()?;
        Ok(db)
    }

    fn init_tables(&self) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                title TEXT NOT NULL,
                filename TEXT NOT NULL,
                save_path TEXT NOT NULL,
                total_bytes INTEGER NOT NULL DEFAULT 0,
                downloaded_bytes INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'queued',
                speed REAL NOT NULL DEFAULT 0.0,
                eta INTEGER NOT NULL DEFAULT 0,
                threads INTEGER NOT NULL DEFAULT 8,
                category TEXT NOT NULL DEFAULT 'Other',
                error_msg TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT
            );

            CREATE TABLE IF NOT EXISTS segments (
                task_id TEXT NOT NULL,
                segment_index INTEGER NOT NULL,
                start_byte INTEGER NOT NULL,
                current_byte INTEGER NOT NULL,
                end_byte INTEGER NOT NULL,
                status TEXT NOT NULL,
                PRIMARY KEY (task_id, segment_index),
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )?;

        // Auto-migrate legacy columns if upgrading from earlier version
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN completed_at TEXT", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN threads INTEGER NOT NULL DEFAULT 8", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN category TEXT NOT NULL DEFAULT 'Other'", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN error_msg TEXT", []);

        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
            CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at);",
        )?;
        Ok(())
    }

    pub fn insert_task(&self, task: &Task) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO tasks (
                id, url, title, filename, save_path, total_bytes, downloaded_bytes,
                status, speed, eta, threads, category, error_msg, created_at, updated_at, completed_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                task.id,
                task.url,
                task.title,
                task.filename,
                task.save_path,
                task.total_bytes,
                task.downloaded_bytes,
                task.status,
                task.speed,
                task.eta,
                task.threads,
                task.category,
                task.error_msg,
                task.created_at.to_rfc3339(),
                task.updated_at.to_rfc3339(),
                task.completed_at.map(|d| d.to_rfc3339())
            ],
        )?;
        Ok(())
    }

    pub fn get_task(&self, id: &str) -> Result<Option<Task>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, url, title, filename, save_path, total_bytes, downloaded_bytes,
                    status, speed, eta, threads, category, error_msg, created_at, updated_at, completed_at
             FROM tasks WHERE id = ?1",
        )?;

        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            let created_at_str: String = row.get(13)?;
            let updated_at_str: String = row.get(14)?;
            let completed_at_str: Option<String> = row.get(15)?;

            Ok(Some(Task {
                id: row.get(0)?,
                url: row.get(1)?,
                title: row.get(2)?,
                filename: row.get(3)?,
                save_path: row.get(4)?,
                total_bytes: row.get(5)?,
                downloaded_bytes: row.get(6)?,
                status: row.get(7)?,
                speed: row.get(8)?,
                eta: row.get(9)?,
                threads: row.get(10)?,
                category: row.get(11)?,
                error_msg: row.get(12)?,
                created_at: DateTime::parse_from_rfc3339(&created_at_str)
                    .unwrap_or_default()
                    .with_timezone(&Utc),
                updated_at: DateTime::parse_from_rfc3339(&updated_at_str)
                    .unwrap_or_default()
                    .with_timezone(&Utc),
                completed_at: completed_at_str.and_then(|s| {
                    DateTime::parse_from_rfc3339(&s)
                        .ok()
                        .map(|d| d.with_timezone(&Utc))
                }),
            }))
        } else {
            Ok(None)
        }
    }

    pub fn list_tasks(&self) -> Result<Vec<Task>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, url, title, filename, save_path, total_bytes, downloaded_bytes,
                    status, speed, eta, threads, category, error_msg, created_at, updated_at, completed_at
             FROM tasks ORDER BY created_at DESC",
        )?;

        let task_iter = stmt.query_map([], |row| {
            let created_at_str: String = row.get(13)?;
            let updated_at_str: String = row.get(14)?;
            let completed_at_str: Option<String> = row.get(15)?;

            Ok(Task {
                id: row.get(0)?,
                url: row.get(1)?,
                title: row.get(2)?,
                filename: row.get(3)?,
                save_path: row.get(4)?,
                total_bytes: row.get(5)?,
                downloaded_bytes: row.get(6)?,
                status: row.get(7)?,
                speed: row.get(8)?,
                eta: row.get(9)?,
                threads: row.get(10)?,
                category: row.get(11)?,
                error_msg: row.get(12)?,
                created_at: DateTime::parse_from_rfc3339(&created_at_str)
                    .unwrap_or_default()
                    .with_timezone(&Utc),
                updated_at: DateTime::parse_from_rfc3339(&updated_at_str)
                    .unwrap_or_default()
                    .with_timezone(&Utc),
                completed_at: completed_at_str.and_then(|s| {
                    DateTime::parse_from_rfc3339(&s)
                        .ok()
                        .map(|d| d.with_timezone(&Utc))
                }),
            })
        })?;

        let mut tasks = Vec::new();
        for task in task_iter {
            tasks.push(task?);
        }
        Ok(tasks)
    }

    pub fn update_task_progress(
        &self,
        id: &str,
        downloaded: i64,
        total: i64,
        speed: f64,
        eta: i64,
    ) -> Result<()> {
        let conn = self.conn.lock();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE tasks SET downloaded_bytes = ?1, total_bytes = ?2, speed = ?3, eta = ?4, updated_at = ?5
             WHERE id = ?6",
            params![downloaded, total, speed, eta, now, id],
        )?;
        Ok(())
    }

    pub fn update_task_status(&self, id: &str, status: &str, error_msg: Option<&str>) -> Result<()> {
        let conn = self.conn.lock();
        let now = Utc::now();
        let now_str = now.to_rfc3339();
        let completed_at = if status == "completed" {
            Some(now_str.clone())
        } else {
            None
        };

        conn.execute(
            "UPDATE tasks SET status = ?1, error_msg = ?2, updated_at = ?3, completed_at = COALESCE(?4, completed_at)
             WHERE id = ?5",
            params![status, error_msg, now_str, completed_at, id],
        )?;
        Ok(())
    }

    pub fn delete_task(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn load_settings(&self) -> Result<AppSettings> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let mut rows = stmt.query([])?;

        let mut settings = AppSettings::default();
        while let Some(row) = rows.next()? {
            let key: String = row.get(0)?;
            let value: String = row.get(1)?;
            match key.as_str() {
                "pre_allocated_threads" => {
                    if let Ok(v) = value.parse() {
                        settings.pre_allocated_threads = v;
                    }
                }
                "auto_speed_boost" => settings.auto_speed_boost = value == "true",
                "download_path" => settings.download_path = value,
                "duplicate_action" => settings.duplicate_action = value,
                "proxy" => settings.proxy = if value.is_empty() { None } else { Some(value) },
                "browser_extension_enabled" => settings.browser_extension_enabled = value == "true",
                "pair_token" => settings.pair_token = value,
                "speed_limit" => {
                    if let Ok(v) = value.parse() {
                        settings.speed_limit = v;
                    }
                }
                "max_active_tasks" => {
                    if let Ok(v) = value.parse() {
                        settings.max_active_tasks = v;
                    }
                }
                "auto_categorize" => settings.auto_categorize = value == "true",
                "protocol_vortex" => settings.protocol_vortex = value == "true",
                "open_torrent" => settings.open_torrent = value == "true",
                "open_magnet" => settings.open_magnet = value == "true",
                "open_ed2k" => settings.open_ed2k = value == "true",
                "open_ftp" => settings.open_ftp = value == "true",
                "open_m3u8" => settings.open_m3u8 = value == "true",
                _ => {}
            }
        }
        Ok(settings)
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<()> {
        let conn = self.conn.lock();
        let pairs = [
            ("pre_allocated_threads", settings.pre_allocated_threads.to_string()),
            ("auto_speed_boost", settings.auto_speed_boost.to_string()),
            ("download_path", settings.download_path.clone()),
            ("duplicate_action", settings.duplicate_action.clone()),
            ("proxy", settings.proxy.clone().unwrap_or_default()),
            ("browser_extension_enabled", settings.browser_extension_enabled.to_string()),
            ("pair_token", settings.pair_token.clone()),
            ("speed_limit", settings.speed_limit.to_string()),
            ("max_active_tasks", settings.max_active_tasks.to_string()),
            ("auto_categorize", settings.auto_categorize.to_string()),
            ("protocol_vortex", settings.protocol_vortex.to_string()),
            ("open_torrent", settings.open_torrent.to_string()),
            ("open_magnet", settings.open_magnet.to_string()),
            ("open_ed2k", settings.open_ed2k.to_string()),
            ("open_ftp", settings.open_ftp.to_string()),
            ("open_m3u8", settings.open_m3u8.to_string()),
        ];

        for (k, v) in pairs {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = ?2",
                params![k, v],
            )?;
        }
        Ok(())
    }
}
