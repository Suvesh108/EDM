use std::path::Path;
use tracing::{debug, warn};

#[cfg(windows)]
#[repr(C)]
struct DATA_BLOB {
    cb_data: u32,
    pb_data: *mut u8,
}

#[cfg(windows)]
#[link(name = "crypt32")]
extern "system" {
    fn CryptProtectData(
        p_data_in: *const DATA_BLOB,
        sz_data_descr: *const u16,
        p_optional_entropy: *const DATA_BLOB,
        pv_reserved: *mut std::ffi::c_void,
        p_prompt_struct: *mut std::ffi::c_void,
        dw_flags: u32,
        p_data_out: *mut DATA_BLOB,
    ) -> i32;

    fn CryptUnprotectData(
        p_data_in: *const DATA_BLOB,
        ppsz_data_descr: *mut *mut u16,
        p_optional_entropy: *const DATA_BLOB,
        pv_reserved: *mut std::ffi::c_void,
        p_prompt_struct: *mut std::ffi::c_void,
        dw_flags: u32,
        p_data_out: *mut DATA_BLOB,
    ) -> i32;
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(h_mem: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    fn GetDiskFreeSpaceExW(
        lp_directory_name: *const u16,
        lp_free_bytes_available_to_caller: *mut u64,
        lp_total_number_of_bytes: *mut u64,
        lp_total_number_of_free_bytes: *mut u64,
    ) -> i32;
}

const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

/// Encrypt sensitive data (such as auth cookies or tokens) using Windows DPAPI.
/// Data is encrypted with the current Windows user's credentials and can only be decrypted
/// by the same user on the same machine.
pub fn encrypt_dpapi(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.is_empty() {
        return Ok(Vec::new());
    }

    #[cfg(windows)]
    unsafe {
        let in_blob = DATA_BLOB {
            cb_data: data.len() as u32,
            pb_data: data.as_ptr() as *mut u8,
        };
        let mut out_blob = DATA_BLOB {
            cb_data: 0,
            pb_data: std::ptr::null_mut(),
        };

        let success = CryptProtectData(
            &in_blob,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        );

        if success == 0 || out_blob.pb_data.is_null() {
            return Err("CryptProtectData failed".into());
        }

        let slice = std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize);
        let result = slice.to_vec();
        LocalFree(out_blob.pb_data as *mut std::ffi::c_void);
        Ok(result)
    }

    #[cfg(not(windows))]
    {
        // Transparent fallback for non-Windows development/testing
        Ok(data.to_vec())
    }
}

/// Decrypt sensitive data previously encrypted with `encrypt_dpapi`.
pub fn decrypt_dpapi(cipher: &[u8]) -> Result<Vec<u8>, String> {
    if cipher.is_empty() {
        return Ok(Vec::new());
    }

    #[cfg(windows)]
    unsafe {
        let in_blob = DATA_BLOB {
            cb_data: cipher.len() as u32,
            pb_data: cipher.as_ptr() as *mut u8,
        };
        let mut out_blob = DATA_BLOB {
            cb_data: 0,
            pb_data: std::ptr::null_mut(),
        };

        let success = CryptUnprotectData(
            &in_blob,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        );

        if success == 0 || out_blob.pb_data.is_null() {
            return Err("CryptUnprotectData failed".into());
        }

        let slice = std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize);
        let result = slice.to_vec();
        LocalFree(out_blob.pb_data as *mut std::ffi::c_void);
        Ok(result)
    }

    #[cfg(not(windows))]
    {
        Ok(cipher.to_vec())
    }
}

/// Checks if a filename has a masqueraded double extension (e.g. `report.pdf.exe` or `image.png.scr`).
pub fn check_double_extension(filename: &str) -> Option<String> {
    let lower = filename.to_lowercase();
    let dangerous_exts = ["exe", "scr", "bat", "cmd", "vbs", "js", "msi", "ps1", "hta"];
    let benign_exts = ["pdf", "mp4", "mp3", "png", "jpg", "jpeg", "doc", "docx", "xls", "xlsx", "zip", "txt"];

    let parts: Vec<&str> = lower.split('.').collect();
    if parts.len() >= 3 {
        let final_ext = parts.last().unwrap_or(&"");
        let prev_ext = parts[parts.len() - 2];
        if dangerous_exts.contains(final_ext) && benign_exts.contains(&prev_ext) {
            return Some(format!(
                "Suspicious double extension detected ('.{}.{}'): masquerading executable",
                prev_ext, final_ext
            ));
        }
    }
    None
}

/// Checks available free disk space on the drive housing `target_dir` before downloading.
pub fn check_disk_space(target_dir: &Path, needed_bytes: u64) -> Result<(), String> {
    #[cfg(windows)]
    unsafe {
        use std::os::windows::ffi::OsStrExt;

        let canonical_or_target = if target_dir.exists() {
            target_dir.to_path_buf()
        } else if let Some(parent) = target_dir.parent() {
            parent.to_path_buf()
        } else {
            target_dir.to_path_buf()
        };

        let mut path_u16: Vec<u16> = canonical_or_target.as_os_str().encode_wide().collect();
        path_u16.push(0);

        let mut free_available: u64 = 0;
        let mut total_bytes: u64 = 0;
        let mut total_free: u64 = 0;

        let ret = GetDiskFreeSpaceExW(
            path_u16.as_ptr(),
            &mut free_available,
            &mut total_bytes,
            &mut total_free,
        );

        if ret != 0 {
            // Reserve a safe buffer of 50 MB
            let buffer_bytes = 50 * 1024 * 1024;
            if free_available < needed_bytes.saturating_add(buffer_bytes) {
                let free_mb = free_available / (1024 * 1024);
                let needed_mb = needed_bytes / (1024 * 1024);
                return Err(format!(
                    "Insufficient disk space: {} MB available, but {} MB required",
                    free_mb, needed_mb
                ));
            }
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = (target_dir, needed_bytes);
        Ok(())
    }
}

/// Preserves Windows Mark-of-the-Web (MOTW) on downloaded files via NTFS Alternate Data Stream `:Zone.Identifier`.
pub fn apply_mark_of_the_web(file_path: &Path, source_url: Option<&str>) -> Result<(), String> {
    #[cfg(windows)]
    {
        if !file_path.exists() {
            return Err("File does not exist".into());
        }

        let ads_path_str = format!("{}:Zone.Identifier", file_path.to_string_lossy());
        let mut content = String::from("[ZoneTransfer]\r\nZoneId=3\r\n");
        if let Some(url) = source_url {
            content.push_str(&format!("HostUrl={}\r\n", url));
        }

        match std::fs::write(&ads_path_str, content.as_bytes()) {
            Ok(_) => {
                debug!("Applied MOTW Zone.Identifier=3 to {:?}", file_path);
                Ok(())
            }
            Err(e) => {
                warn!("Failed to write Zone.Identifier ADS to {:?}: {}", file_path, e);
                // Non-fatal if filesystem doesn't support ADS (e.g. FAT32/exFAT)
                Ok(())
            }
        }
    }

    #[cfg(not(windows))]
    {
        let _ = (file_path, source_url);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dpapi_roundtrip() {
        let secret = b"my_secret_auth_cookie=session12345";
        let encrypted = encrypt_dpapi(secret).expect("encryption failed");
        assert_ne!(secret, encrypted.as_slice());
        let decrypted = decrypt_dpapi(&encrypted).expect("decryption failed");
        assert_eq!(secret, decrypted.as_slice());
    }

    #[test]
    fn test_double_extension_detection() {
        assert!(check_double_extension("invoice.pdf.exe").is_some());
        assert!(check_double_extension("movie.mp4.scr").is_some());
        assert!(check_double_extension("setup.msi").is_none());
        assert!(check_double_extension("normal_file.pdf").is_none());
        assert!(check_double_extension("archive.tar.gz").is_none());
    }
}
