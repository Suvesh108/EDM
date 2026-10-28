//! Asynchronous Pipelined Disk Writer
//! Moves all disk writes completely off the async Tokio network receive path.
//! Workers push chunks into a bounded mpsc channel; a dedicated thread writes
//! data at positional offsets in large batches without blocking packet ingestion.

use std::fs::OpenOptions;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

pub struct WriteChunk {
    pub offset: u64,
    pub data: Vec<u8>,
}

pub struct PipelinedWriterHandle {
    sender: mpsc::Sender<WriteChunk>,
    cancelled: Arc<AtomicBool>,
    part_path: PathBuf,
    final_path: PathBuf,
    writer_thread: Option<std::thread::JoinHandle<Result<(), io::Error>>>,
}

impl PipelinedWriterHandle {
    pub fn new<P: AsRef<Path>>(
        target_dir: P,
        filename: &str,
        total_size: Option<u64>,
        channel_capacity: usize,
    ) -> Result<Self, io::Error> {
        let final_path = target_dir.as_ref().join(filename);
        let part_filename = format!("{}.edmpart", filename);
        let part_path = target_dir.as_ref().join(part_filename);

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&part_path)?;

        // Pre-allocate / sparse extend once
        if let Some(size) = total_size {
            if size > 0 {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::FileExt;
                    let _ = file.seek_write(&[0u8], size.saturating_sub(1));
                }
                #[cfg(not(windows))]
                {
                    let _ = file.set_len(size);
                }
            }
        }

        let (sender, mut receiver) = mpsc::channel::<WriteChunk>(channel_capacity);
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancelled_clone = cancelled.clone();

        let writer_thread = std::thread::Builder::new()
            .name("edm-pipeline-writer".into())
            .spawn(move || -> Result<(), io::Error> {
                let file = file;
                let mut last_flush = Instant::now();

                while let Some(chunk) = receiver.blocking_recv() {
                    if cancelled_clone.load(Ordering::Relaxed) {
                        break;
                    }

                    #[cfg(windows)]
                    {
                        use std::os::windows::fs::FileExt;
                        file.seek_write(&chunk.data, chunk.offset)?;
                    }
                    #[cfg(not(windows))]
                    {
                        use std::io::{Seek, SeekFrom, Write};
                        let mut f = &file;
                        f.seek(SeekFrom::Start(chunk.offset))?;
                        f.write_all(&chunk.data)?;
                    }

                    // Periodic timed flush every 3 seconds to avoid blocking workers
                    if last_flush.elapsed() >= Duration::from_secs(3) {
                        let _ = file.sync_data();
                        last_flush = Instant::now();
                    }
                }

                // Final sync before thread exits
                let _ = file.sync_data();
                Ok(())
            })?;

        Ok(Self {
            sender,
            cancelled,
            part_path,
            final_path,
            writer_thread: Some(writer_thread),
        })
    }

    pub fn sender(&self) -> mpsc::Sender<WriteChunk> {
        self.sender.clone()
    }

    pub fn finish(mut self, referer_or_url: Option<&str>) -> Result<PathBuf, io::Error> {
        // Drop sender to signal EOF to the writer thread
        drop(self.sender);

        if let Some(handle) = self.writer_thread.take() {
            if let Ok(res) = handle.join() {
                res?;
            }
        }

        // Apply atomic rename
        if self.final_path.exists() {
            let _ = std::fs::remove_file(&self.final_path);
        }
        std::fs::rename(&self.part_path, &self.final_path)?;

        // Attach Mark-of-the-Web (ZoneId=3) on Windows
        #[cfg(windows)]
        if let Some(source_url) = referer_or_url {
            use std::io::Write;
            let zone_path = format!("{}:Zone.Identifier", self.final_path.display());
            if let Ok(mut zone_file) = std::fs::File::create(&zone_path) {
                let _ = writeln!(
                    zone_file,
                    "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl={}",
                    source_url
                );
            }
        }

        Ok(self.final_path)
    }

    pub fn abort(&mut self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
}
