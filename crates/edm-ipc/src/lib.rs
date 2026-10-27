use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const PROTOCOL_VERSION: u32 = 1;
pub const DEFAULT_PIPE_NAME: &str = r"\\.\pipe\edm_ipc_service";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Cookie {
    pub name: String,
    pub value: String,
    pub domain: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MediaVariant {
    pub quality: String,
    pub url: String,
    #[serde(rename = "type")]
    pub media_type: String, // hls, dash, mp4
    pub resolution: Option<String>,
    pub bitrate: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExtensionMessage {
    Hello {
        protocol: u32,
        #[serde(rename = "extensionVersion")]
        extension_version: String,
        browser: String,
    },
    AddDownload {
        url: String,
        #[serde(rename = "finalUrl", default)]
        final_url: Option<String>,
        #[serde(default)]
        referrer: Option<String>,
        #[serde(rename = "userAgent", default)]
        user_agent: Option<String>,
        #[serde(default)]
        cookies: Vec<Cookie>,
        #[serde(default)]
        filename: Option<String>,
        #[serde(default)]
        mime: Option<String>,
        #[serde(default)]
        size: Option<u64>,
        #[serde(rename = "tabUrl", default)]
        tab_url: Option<String>,
        #[serde(default)]
        source: Option<String>,
    },
    AddMany {
        items: Vec<ExtensionMessage>,
    },
    MediaDetected {
        #[serde(rename = "pageUrl")]
        page_url: String,
        title: String,
        variants: Vec<MediaVariant>,
    },
    Ping,
    GetStatus,
    ListDownloads {
        #[serde(default)]
        filter: Option<String>,
    },
    GetDownload {
        id: Uuid,
    },
    PauseDownload {
        id: Uuid,
    },
    ResumeDownload {
        id: Uuid,
    },
    CancelDownload {
        id: Uuid,
    },
    RetryDownload {
        id: Uuid,
    },
    OpenDownloadedFile {
        id: Uuid,
    },
    OpenDownloadFolder {
        id: Uuid,
    },
    RemoveDownloadHistory {
        id: Uuid,
    },
    GetToken,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AppReply {
    Token {
        token: String,
    },
    Accepted {
        id: Uuid,
    },
    Declined {
        reason: String,
    },
    Error {
        message: String,
    },
    Settings {
        #[serde(rename = "minSize")]
        min_size: u64,
        #[serde(rename = "takeOverExtensions")]
        take_over_extensions: Vec<String>,
        #[serde(rename = "excludedDomains")]
        excluded_domains: Vec<String>,
    },
    Pong,
    Status {
        status: String,
        version: String,
        protocol: u32,
        active_downloads: usize,
        queued_tasks: usize,
        completed_tasks: usize,
        aggregate_speed_bps: u64,
    },
    DownloadList {
        downloads: Vec<DownloadOverview>,
        active_count: usize,
        queued_count: usize,
        completed_count: usize,
        aggregate_speed_bps: u64,
    },
    DownloadDetail {
        download: DownloadOverview,
    },
    Success {
        action: String,
        id: Option<Uuid>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DownloadState {
    Created,
    Probing,
    Queued,
    Downloading,
    Paused,
    LinkExpired,
    NeedsAttention,
    Verifying,
    Completed,
    Failed,
    Cancelled,
}

impl DownloadState {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled)
    }

    pub fn can_transition_to(&self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Created, Self::Probing)
                | (
                    Self::Probing,
                    Self::Queued | Self::Failed | Self::NeedsAttention
                )
                | (
                    Self::Queued,
                    Self::Downloading | Self::Paused | Self::Cancelled
                )
                | (
                    Self::Downloading,
                    Self::Paused
                        | Self::Verifying
                        | Self::Failed
                        | Self::LinkExpired
                        | Self::Cancelled
                )
                | (Self::Paused, Self::Queued | Self::Cancelled)
                | (Self::LinkExpired, Self::Queued | Self::Cancelled)
                | (Self::NeedsAttention, Self::Queued | Self::Cancelled)
                | (Self::Verifying, Self::Completed | Self::Failed)
                | (Self::Failed, Self::Queued | Self::Cancelled)
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SegmentState {
    Pending,
    Downloading,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DownloadOverview {
    pub id: Uuid,
    pub url: String,
    pub filename: String,
    pub save_dir: String,
    pub category: String,
    pub state: DownloadState,
    pub size_total: Option<u64>,
    pub size_done: u64,
    pub resumable: bool,
    pub speed_bytes_per_sec: u64,
    pub connections: u32,
    pub created_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub error_msg: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_state_transitions() {
        assert!(DownloadState::Created.can_transition_to(DownloadState::Probing));
        assert!(DownloadState::Probing.can_transition_to(DownloadState::Queued));
        assert!(DownloadState::Queued.can_transition_to(DownloadState::Downloading));
        assert!(DownloadState::Downloading.can_transition_to(DownloadState::Paused));
        assert!(!DownloadState::Completed.can_transition_to(DownloadState::Downloading));
    }
}
