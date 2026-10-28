//! FFmpeg Media Toolchain Feature Pack (Native Rust Implementation)
//! Features: Media processing support for compatible workflows, stream copy transmuxing, audio track demuxing

use super::process::configure_hidden_command;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FfmpegCapability {
    pub is_available: bool,
    pub version: Option<String>,
    pub binary_path: Option<String>,
    pub supports_nvenc: bool,
    pub supports_qsv: bool,
}

pub struct FfmpegPack;

impl FfmpegPack {
    /// Detect FFmpeg binary location (prioritizing EDM local tools directory)
    pub fn locate_binary() -> Option<PathBuf> {
        // 1. Check local EDM appdata tools directory
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let p = PathBuf::from(local_app_data)
                .join("EDM")
                .join("tools")
                .join("ffmpeg.exe");
            if p.exists() {
                return Some(p);
            }
        }

        // 2. Check standard system PATH
        if let Ok(path_var) = std::env::var("PATH") {
            for entry in std::env::split_paths(&path_var) {
                let candidate = entry.join("ffmpeg.exe");
                if candidate.exists() {
                    return Some(candidate);
                }
                #[cfg(not(windows))]
                {
                    let unix_candidate = entry.join("ffmpeg");
                    if unix_candidate.exists() {
                        return Some(unix_candidate);
                    }
                }
            }
        }

        None
    }

    /// Query FFmpeg version and hardware acceleration capabilities
    pub async fn get_capabilities() -> FfmpegCapability {
        let binary_path = Self::locate_binary();
        if binary_path.is_none() {
            return FfmpegCapability {
                is_available: false,
                version: None,
                binary_path: None,
                supports_nvenc: false,
                supports_qsv: false,
            };
        }

        let bin = binary_path.clone().unwrap();
        let output = configure_hidden_command(&bin, ["-version"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output()
            .await;

        let (version, supports_nvenc, supports_qsv) = match output {
            Ok(out) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout);
                let first_line = text.lines().next().unwrap_or("FFmpeg").to_string();
                let nvenc = text.contains("nvenc") || text.contains("cuvid");
                let qsv = text.contains("qsv") || text.contains("vpl");
                (Some(first_line), nvenc, qsv)
            }
            _ => (None, false, false),
        };

        FfmpegCapability {
            is_available: version.is_some(),
            version,
            binary_path: Some(bin.to_string_lossy().to_string()),
            supports_nvenc,
            supports_qsv,
        }
    }

    /// Losslessly transmux transport stream chunks (.ts) into a standalone MP4 container without re-encoding
    pub async fn transmux_to_mp4(input_path: &Path, output_path: &Path) -> Result<(), String> {
        let bin =
            Self::locate_binary().ok_or_else(|| "FFmpeg binary not found on system".to_string())?;

        let mut child = super::process::spawn_hidden(
            bin,
            [
                "-y",
                "-i",
                input_path.to_str().unwrap_or(""),
                "-c",
                "copy",
                "-bsf:a",
                "aac_adtstoasc",
                output_path.to_str().unwrap_or(""),
            ],
            false,
            true,
        )
        .map_err(|e| format!("Failed to spawn hidden FFmpeg process: {}", e))?;

        let status = child
            .wait()
            .await
            .map_err(|e| format!("FFmpeg process wait error: {}", e))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "FFmpeg transmux exited with error code: {:?}",
                status.code()
            ))
        }
    }

    /// Extract audio track losslessly (e.g. from MP4 to MP3 or AAC)
    pub async fn extract_audio(input_path: &Path, output_path: &Path) -> Result<(), String> {
        let bin =
            Self::locate_binary().ok_or_else(|| "FFmpeg binary not found on system".to_string())?;

        let mut child = super::process::spawn_hidden(
            bin,
            [
                "-y",
                "-i",
                input_path.to_str().unwrap_or(""),
                "-vn",
                "-c:a",
                "copy",
                output_path.to_str().unwrap_or(""),
            ],
            false,
            true,
        )
        .map_err(|e| format!("Failed to spawn hidden FFmpeg process: {}", e))?;

        let status = child
            .wait()
            .await
            .map_err(|e| format!("FFmpeg audio process wait error: {}", e))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "FFmpeg audio extraction exited with code: {:?}",
                status.code()
            ))
        }
    }
}
