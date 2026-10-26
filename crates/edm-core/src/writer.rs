use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use thiserror::Error;

#[cfg(windows)]
use std::os::windows::fs::FileExt;

#[derive(Error, Debug)]
pub enum WriterError {
    #[error("IO error: {0}")]
    Io(#[from] io::Error),
    #[error("File already exists: {0}")]
    AlreadyExists(String),
}

#[derive(Clone)]
pub struct FileWriter {
    file: Arc<Mutex<Option<File>>>,
    part_path: PathBuf,
    final_path: PathBuf,
    pub total_size: Option<u64>,
}

impl FileWriter {
    pub fn new<P: AsRef<Path>>(
        target_dir: P,
        filename: &str,
        total_size: Option<u64>,
    ) -> Result<Self, WriterError> {
        let final_path = target_dir.as_ref().join(filename);
        let part_filename = format!("{}.edmpart", filename);
        let part_path = target_dir.as_ref().join(part_filename);

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&part_path)?;

        // Pre-allocate if size is known using NTFS sparse allocation when on Windows
        if let Some(size) = total_size {
            #[cfg(windows)]
            unsafe {
                use std::os::windows::io::AsRawHandle;
                const FSCTL_SET_SPARSE: u32 = 0x000900C4;
                extern "system" {
                    fn DeviceIoControl(
                        hDevice: isize,
                        dwIoControlCode: u32,
                        lpInBuffer: *const std::ffi::c_void,
                        nInBufferSize: u32,
                        lpOutBuffer: *mut std::ffi::c_void,
                        nOutBufferSize: u32,
                        lpBytesReturned: *mut u32,
                        lpOverlapped: *mut std::ffi::c_void,
                    ) -> i32;
                }

                let handle = file.as_raw_handle();
                let mut bytes_returned = 0u32;
                let _ = DeviceIoControl(
                    handle as isize,
                    FSCTL_SET_SPARSE,
                    std::ptr::null(),
                    0,
                    std::ptr::null_mut(),
                    0,
                    &mut bytes_returned,
                    std::ptr::null_mut(),
                );
            }
            file.set_len(size)?;
        }

        Ok(Self {
            file: Arc::new(Mutex::new(Some(file))),
            part_path,
            final_path,
            total_size,
        })
    }

    pub fn write_at(&self, offset: u64, data: &[u8]) -> Result<(), WriterError> {
        let guard = self.file.lock().unwrap();
        if let Some(ref file) = *guard {
            #[cfg(windows)]
            {
                file.seek_write(data, offset)?;
            }

            #[cfg(not(windows))]
            {
                use std::io::Seek;
                use std::io::SeekFrom;
                let mut file_ref = &*file;
                (&file_ref).seek(SeekFrom::Start(offset))?;
                (&file_ref).write_all(data)?;
            }
        }

        Ok(())
    }

    pub fn flush(&self) -> Result<(), WriterError> {
        let guard = self.file.lock().unwrap();
        if let Some(ref file) = *guard {
            file.sync_data()?;
        }
        Ok(())
    }

    pub fn finalize(&self, referer_or_url: Option<&str>) -> Result<PathBuf, WriterError> {
        self.flush()?;

        // Close file handle by taking Option<File> and dropping it immediately to release Windows file lock
        {
            let mut guard = self.file.lock().unwrap();
            let _ = guard.take();
        }

        if self.final_path.exists() {
            // Apply duplicate rename policy if needed or overwrite
            let _ = std::fs::remove_file(&self.final_path);
        }

        std::fs::rename(&self.part_path, &self.final_path)?;

        // Attach Windows Mark-of-the-Web (Zone.Identifier)
        #[cfg(windows)]
        if let Some(source_url) = referer_or_url {
            let zone_stream_path = format!("{}:Zone.Identifier", self.final_path.to_string_lossy());
            if let Ok(mut zone_file) = File::create(&zone_stream_path) {
                let _ = writeln!(
                    zone_file,
                    "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl={}",
                    source_url
                );
            }
        }

        Ok(self.final_path.clone())
    }
}
