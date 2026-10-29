use chrono::{DateTime, Utc};
use edm_ipc::DownloadState;
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::{Arc, Mutex};
use thiserror::Error;
use uuid::Uuid;

#[derive(Error, Debug)]
pub enum StoreError {
    #[error("Database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Not found: {0}")]
    NotFound(String),
}

pub struct DownloadRecord {
    pub id: Uuid,
    pub url: String,
    pub final_url: Option<String>,
    pub filename: String,
    pub save_dir: String,
    pub category: String,
    pub state: DownloadState,
    pub size_total: Option<u64>,
    pub size_done: u64,
    pub resumable: bool,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_type: Option<String>,
    pub referer: Option<String>,
    pub user_agent: Option<String>,
    pub connections: u32,
    pub created_at: DateTime<Utc>,
    pub error_msg: Option<String>,
}

pub struct SegmentRecord {
    pub download_id: Uuid,
    pub idx: u32,
    pub start: u64,
    pub end: u64,
    pub pos: u64,
    pub state: String,
    pub retries: u32,
}

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

impl Store {
    pub fn open<P: AsRef<Path>>(path: P) -> std::result::Result<Self, StoreError> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            "#,
        )?;

        let store = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        store.migrate()?;
        Ok(store)
    }

    pub fn open_in_memory() -> std::result::Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            r#"
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            "#,
        )?;

        let store = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> std::result::Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS downloads (
                id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                final_url TEXT,
                filename TEXT NOT NULL,
                save_dir TEXT NOT NULL,
                category TEXT NOT NULL,
                state TEXT NOT NULL,
                size_total INTEGER,
                size_done INTEGER NOT NULL DEFAULT 0,
                resumable INTEGER NOT NULL DEFAULT 1,
                etag TEXT,
                last_modified TEXT,
                content_type TEXT,
                referer TEXT,
                user_agent TEXT,
                headers_json TEXT,
                connections INTEGER NOT NULL DEFAULT 8,
                speed_limit INTEGER,
                queue_id TEXT,
                priority INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT 'manual',
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                error_code TEXT,
                error_msg TEXT,
                checksum_algo TEXT,
                checksum_expected TEXT,
                checksum_actual TEXT
            );

            CREATE TABLE IF NOT EXISTS segments (
                download_id TEXT NOT NULL,
                idx INTEGER NOT NULL,
                start INTEGER NOT NULL,
                "end" INTEGER NOT NULL,
                pos INTEGER NOT NULL,
                state TEXT NOT NULL DEFAULT 'pending',
                retries INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (download_id, idx),
                FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS queues (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                max_concurrent INTEGER NOT NULL DEFAULT 3,
                schedule_json TEXT,
                post_action TEXT NOT NULL DEFAULT 'none'
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS event_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                download_id TEXT,
                ts TEXT NOT NULL,
                level TEXT NOT NULL,
                message TEXT NOT NULL
            );
            "#,
        )?;
        Ok(())
    }

    pub fn insert_download(&self, dl: &DownloadRecord) -> std::result::Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO downloads (
                id, url, final_url, filename, save_dir, category, state,
                size_total, size_done, resumable, etag, last_modified,
                content_type, referer, user_agent, connections, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
            "#,
            params![
                dl.id.to_string(),
                dl.url,
                dl.final_url,
                dl.filename,
                dl.save_dir,
                dl.category,
                format!("{:?}", dl.state).to_lowercase(),
                dl.size_total,
                dl.size_done,
                dl.resumable as i32,
                dl.etag,
                dl.last_modified,
                dl.content_type,
                dl.referer,
                dl.user_agent,
                dl.connections,
                dl.created_at.to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn update_download_state(
        &self,
        id: Uuid,
        state: DownloadState,
        error_msg: Option<&str>,
    ) -> std::result::Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE downloads SET state = ?1, error_msg = ?2 WHERE id = ?3",
            params![
                format!("{:?}", state).to_lowercase(),
                error_msg,
                id.to_string()
            ],
        )?;
        Ok(())
    }

    pub fn update_download_progress(
        &self,
        id: Uuid,
        size_done: u64,
    ) -> std::result::Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE downloads SET size_done = ?1 WHERE id = ?2",
            params![size_done, id.to_string()],
        )?;
        Ok(())
    }

    pub fn save_segment_positions(
        &self,
        segments: &[SegmentRecord],
    ) -> std::result::Result<(), StoreError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        for s in segments {
            tx.execute(
                r#"
                INSERT INTO segments (download_id, idx, start, "end", pos, state, retries)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                ON CONFLICT(download_id, idx) DO UPDATE SET
                    pos = excluded.pos,
                    state = excluded.state,
                    retries = excluded.retries
                "#,
                params![
                    s.download_id.to_string(),
                    s.idx,
                    s.start,
                    s.end,
                    s.pos,
                    s.state,
                    s.retries
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_download_state(&self, id: Uuid) -> std::result::Result<Option<String>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT state FROM downloads WHERE id = ?1")?;
        let mut rows = stmt.query(params![id.to_string()])?;
        if let Some(row) = rows.next()? {
            let state: String = row.get(0)?;
            Ok(Some(state))
        } else {
            Ok(None)
        }
    }

    pub fn get_setting(&self, key: &str) -> std::result::Result<Option<String>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value_json FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            let val: String = row.get(0)?;
            Ok(Some(val))
        } else {
            Ok(None)
        }
    }

    pub fn set_setting(&self, key: &str, value_json: &str) -> std::result::Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO settings (key, value_json) VALUES (?1, ?2)
            ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
            "#,
            params![key, value_json],
        )?;
        Ok(())
    }

    pub fn list_all_downloads(&self) -> std::result::Result<Vec<DownloadRecord>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, url, final_url, filename, save_dir, category, state,
                   size_total, size_done, resumable, etag, last_modified,
                   content_type, referer, user_agent, connections, created_at, error_msg
            FROM downloads
            ORDER BY created_at DESC
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            let id_str: String = row.get(0)?;
            let id = Uuid::parse_str(&id_str).unwrap_or_default();
            let state_str: String = row.get(6)?;
            let state = match state_str.to_lowercase().as_str() {
                "created" => DownloadState::Created,
                "probing" => DownloadState::Probing,
                "queued" => DownloadState::Queued,
                "downloading" => DownloadState::Downloading,
                "paused" => DownloadState::Paused,
                "linkexpired" | "link_expired" => DownloadState::LinkExpired,
                "needsattention" | "needs_attention" => DownloadState::NeedsAttention,
                "verifying" => DownloadState::Verifying,
                "completed" => DownloadState::Completed,
                "failed" => DownloadState::Failed,
                "cancelled" => DownloadState::Cancelled,
                _ => DownloadState::Queued,
            };
            let resumable_i: i32 = row.get(9)?;
            let created_at_str: String = row.get(16)?;
            let created_at = DateTime::parse_from_rfc3339(&created_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());

            Ok(DownloadRecord {
                id,
                url: row.get(1)?,
                final_url: row.get(2)?,
                filename: row.get(3)?,
                save_dir: row.get(4)?,
                category: row.get(5)?,
                state,
                size_total: row.get(7)?,
                size_done: row.get(8)?,
                resumable: resumable_i != 0,
                etag: row.get(10)?,
                last_modified: row.get(11)?,
                content_type: row.get(12)?,
                referer: row.get(13)?,
                user_agent: row.get(14)?,
                connections: row.get(15)?,
                created_at,
                error_msg: row.get(17)?,
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn delete_download(&self, id: Uuid) -> std::result::Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM segments WHERE download_id = ?1",
            params![id.to_string()],
        )?;
        conn.execute(
            "DELETE FROM downloads WHERE id = ?1",
            params![id.to_string()],
        )?;
        Ok(())
    }

    pub fn checkpoint(&self) -> std::result::Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE); PRAGMA optimize;");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_store_creation_and_migration() {
        let store = Store::open_in_memory().expect("failed to open in memory store");
        let id = Uuid::new_v4();
        let record = DownloadRecord {
            id,
            url: "https://example.com/file.iso".into(),
            final_url: None,
            filename: "file.iso".into(),
            save_dir: "C:\\Downloads".into(),
            category: "Programs".into(),
            state: DownloadState::Created,
            size_total: Some(1048576),
            size_done: 0,
            resumable: true,
            etag: Some("\"etag123\"".into()),
            last_modified: None,
            content_type: Some("application/octet-stream".into()),
            referer: None,
            user_agent: None,
            connections: 8,
            created_at: Utc::now(),
            error_msg: None,
        };

        store
            .insert_download(&record)
            .expect("insert download failed");
        store
            .update_download_state(id, DownloadState::Downloading, None)
            .expect("state update failed");
    }
}
