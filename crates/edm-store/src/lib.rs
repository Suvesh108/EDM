use chrono::{DateTime, Utc};
use edm_ipc::DownloadState;
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::{Arc, Mutex};
use thiserror::Error;
use uuid::Uuid;

use serde::{Deserialize, Serialize};

#[derive(Error, Debug)]
pub enum StoreError {
    #[error("Database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Not found: {0}")]
    NotFound(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryRecord {
    pub id: Uuid,
    pub url: String,
    pub filename: String,
    pub save_dir: String,
    pub category: String,
    pub size_total: Option<u64>,
    pub size_done: u64,
    pub state: String,
    pub created_at: DateTime<Utc>,
    pub completed_at: DateTime<Utc>,
    pub error_msg: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueRecord {
    pub id: String,
    pub name: String,
    pub max_concurrent: u32,
    pub speed_limit_bytes_per_sec: Option<u64>,
    pub schedule_start: Option<String>,
    pub schedule_stop: Option<String>,
    pub schedule_days: Option<String>,
    pub post_action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

            CREATE TABLE IF NOT EXISTS history (
                id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                filename TEXT NOT NULL,
                save_dir TEXT NOT NULL,
                category TEXT NOT NULL,
                size_total INTEGER,
                size_done INTEGER NOT NULL,
                state TEXT NOT NULL,
                created_at TEXT NOT NULL,
                completed_at TEXT NOT NULL,
                error_msg TEXT
            );

            INSERT OR IGNORE INTO queues (id, name, max_concurrent, post_action)
            VALUES ('default', 'Default Queue', 3, 'none');
            "#,
        )?;

        // Non-destructive column additions
        let _ = conn.execute_batch(
            r#"
            ALTER TABLE downloads ADD COLUMN cookies_encrypted BLOB;
            ALTER TABLE queues ADD COLUMN speed_limit_bytes_per_sec INTEGER;
            ALTER TABLE queues ADD COLUMN schedule_start TEXT;
            ALTER TABLE queues ADD COLUMN schedule_stop TEXT;
            ALTER TABLE queues ADD COLUMN schedule_days TEXT;
            "#,
        );
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
            ON CONFLICT(id) DO UPDATE SET
                state = excluded.state,
                connections = excluded.connections,
                error_msg = NULL
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

    pub fn update_download_total_size(
        &self,
        id: Uuid,
        size_total: u64,
    ) -> std::result::Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE downloads SET size_total = ?1 WHERE id = ?2",
            params![size_total as i64, id.to_string()],
        )?;
        Ok(())
    }

    pub fn update_download_size_and_progress(
        &self,
        id: Uuid,
        size_done: u64,
        size_total: Option<u64>,
    ) -> std::result::Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        if let Some(total) = size_total {
            conn.execute(
                "UPDATE downloads SET size_done = ?1, size_total = ?2 WHERE id = ?3",
                params![size_done, total as i64, id.to_string()],
            )?;
        } else {
            conn.execute(
                "UPDATE downloads SET size_done = ?1 WHERE id = ?2",
                params![size_done, id.to_string()],
            )?;
        }
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

    pub fn get_segments(&self, download_id: Uuid) -> std::result::Result<Vec<SegmentRecord>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"
            SELECT idx, start, "end", pos, state, retries
            FROM segments
            WHERE download_id = ?1
            ORDER BY idx ASC
            "#,
        )?;
        let rows = stmt.query_map(params![download_id.to_string()], |row| {
            Ok(SegmentRecord {
                download_id,
                idx: row.get(0)?,
                start: row.get(1)?,
                end: row.get(2)?,
                pos: row.get(3)?,
                state: row.get(4)?,
                retries: row.get(5)?,
            })
        })?;

        let mut results = Vec::new();
        for r in rows {
            results.push(r?);
        }
        Ok(results)
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

    pub fn add_to_history(
        &self,
        record: &DownloadRecord,
        completed_at: DateTime<Utc>,
    ) -> std::result::Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT OR REPLACE INTO history (
                id, url, filename, save_dir, category, size_total, size_done,
                state, created_at, completed_at, error_msg
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            "#,
            params![
                record.id.to_string(),
                record.url,
                record.filename,
                record.save_dir,
                record.category,
                record.size_total,
                record.size_done,
                format!("{:?}", record.state).to_lowercase(),
                record.created_at.to_rfc3339(),
                completed_at.to_rfc3339(),
                record.error_msg,
            ],
        )?;
        Ok(())
    }

    pub fn list_history(
        &self,
        limit: Option<usize>,
        query: Option<&str>,
    ) -> std::result::Result<Vec<HistoryRecord>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let limit_val = limit.unwrap_or(200);
        let q_pattern = query.map(|q| format!("%{}%", q));

        let mut stmt = if q_pattern.is_some() {
            conn.prepare(
                r#"
                SELECT id, url, filename, save_dir, category, size_total, size_done,
                       state, created_at, completed_at, error_msg
                FROM history
                WHERE filename LIKE ?1 OR url LIKE ?1
                ORDER BY completed_at DESC
                LIMIT ?2
                "#,
            )?
        } else {
            conn.prepare(
                r#"
                SELECT id, url, filename, save_dir, category, size_total, size_done,
                       state, created_at, completed_at, error_msg
                FROM history
                ORDER BY completed_at DESC
                LIMIT ?1
                "#,
            )?
        };

        let map_row = |row: &rusqlite::Row| {
            let id_str: String = row.get(0)?;
            let id = Uuid::parse_str(&id_str).unwrap_or_default();
            let created_at_str: String = row.get(8)?;
            let completed_at_str: String = row.get(9)?;
            let created_at = DateTime::parse_from_rfc3339(&created_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());
            let completed_at = DateTime::parse_from_rfc3339(&completed_at_str)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());

            Ok(HistoryRecord {
                id,
                url: row.get(1)?,
                filename: row.get(2)?,
                save_dir: row.get(3)?,
                category: row.get(4)?,
                size_total: row.get(5)?,
                size_done: row.get(6)?,
                state: row.get(7)?,
                created_at,
                completed_at,
                error_msg: row.get(10)?,
            })
        };

        let mut list = Vec::new();
        if let Some(ref pat) = q_pattern {
            let rows = stmt.query_map(params![pat, limit_val], map_row)?;
            for r in rows {
                list.push(r?);
            }
        } else {
            let rows = stmt.query_map(params![limit_val], map_row)?;
            for r in rows {
                list.push(r?);
            }
        }
        Ok(list)
    }

    pub fn clear_history(&self) -> std::result::Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM history", [])?;
        Ok(())
    }

    pub fn export_history_csv(&self) -> std::result::Result<String, StoreError> {
        let items = self.list_history(Some(10000), None)?;
        let mut csv = String::from("id,filename,category,state,size_done,size_total,created_at,completed_at,url\n");
        for h in items {
            let line = format!(
                "\"{}\",\"{}\",\"{}\",\"{}\",{},{},\"{}\",\"{}\",\"{}\"\n",
                h.id,
                h.filename.replace('"', "\"\""),
                h.category.replace('"', "\"\""),
                h.state,
                h.size_done,
                h.size_total.unwrap_or(0),
                h.created_at.to_rfc3339(),
                h.completed_at.to_rfc3339(),
                h.url.replace('"', "\"\""),
            );
            csv.push_str(&line);
        }
        Ok(csv)
    }

    pub fn save_encrypted_cookies(
        &self,
        id: Uuid,
        cookies_blob: &[u8],
    ) -> std::result::Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE downloads SET cookies_encrypted = ?1 WHERE id = ?2",
            params![cookies_blob, id.to_string()],
        )?;
        Ok(())
    }

    pub fn get_encrypted_cookies(&self, id: Uuid) -> std::result::Result<Option<Vec<u8>>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT cookies_encrypted FROM downloads WHERE id = ?1")?;
        let mut rows = stmt.query(params![id.to_string()])?;
        if let Some(row) = rows.next()? {
            let blob: Option<Vec<u8>> = row.get(0)?;
            Ok(blob)
        } else {
            Ok(None)
        }
    }

    pub fn purge_encrypted_cookies(&self, id: Uuid) -> std::result::Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE downloads SET cookies_encrypted = NULL WHERE id = ?1",
            params![id.to_string()],
        )?;
        Ok(())
    }

    pub fn update_download_url(&self, id: Uuid, new_url: &str) -> std::result::Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE downloads SET url = ?1 WHERE id = ?2",
            params![new_url, id.to_string()],
        )?;
        Ok(())
    }

    pub fn find_duplicate(
        &self,
        url: &str,
        filename: &str,
        size: Option<u64>,
    ) -> std::result::Result<Option<DownloadRecord>, StoreError> {
        let all = self.list_all_downloads()?;
        for d in all {
            if d.url.eq_ignore_ascii_case(url) {
                return Ok(Some(d));
            }
            if let Some(s) = size {
                if d.filename.eq_ignore_ascii_case(filename) && d.size_total == Some(s) {
                    return Ok(Some(d));
                }
            }
        }
        Ok(None)
    }

    pub fn list_queues(&self) -> std::result::Result<Vec<QueueRecord>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, name, max_concurrent, speed_limit_bytes_per_sec,
                   schedule_start, schedule_stop, schedule_days, post_action
            FROM queues
            ORDER BY id ASC
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(QueueRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                max_concurrent: row.get::<_, i64>(2)? as u32,
                speed_limit_bytes_per_sec: row.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                schedule_start: row.get(4)?,
                schedule_stop: row.get(5)?,
                schedule_days: row.get(6)?,
                post_action: row.get(7)?,
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn upsert_queue(&self, q: &QueueRecord) -> std::result::Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO queues (
                id, name, max_concurrent, speed_limit_bytes_per_sec,
                schedule_start, schedule_stop, schedule_days, post_action
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                max_concurrent = excluded.max_concurrent,
                speed_limit_bytes_per_sec = excluded.speed_limit_bytes_per_sec,
                schedule_start = excluded.schedule_start,
                schedule_stop = excluded.schedule_stop,
                schedule_days = excluded.schedule_days,
                post_action = excluded.post_action
            "#,
            params![
                q.id,
                q.name,
                q.max_concurrent as i64,
                q.speed_limit_bytes_per_sec.map(|v| v as i64),
                q.schedule_start,
                q.schedule_stop,
                q.schedule_days,
                q.post_action,
            ],
        )?;
        Ok(())
    }

    pub fn delete_queue(&self, queue_id: &str) -> std::result::Result<(), StoreError> {
        if queue_id == "default" {
            return Err(StoreError::NotFound("Cannot delete default queue".into()));
        }
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM queues WHERE id = ?1", params![queue_id])?;
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

        // History test
        store.add_to_history(&record, Utc::now()).expect("add history failed");
        let hist = store.list_history(None, None).expect("list history failed");
        assert_eq!(hist.len(), 1);
        assert_eq!(hist[0].filename, "file.iso");

        let csv = store.export_history_csv().expect("export csv failed");
        assert!(csv.contains("file.iso"));

        // Queue test
        let queues = store.list_queues().expect("list queues failed");
        assert!(queues.iter().any(|q| q.id == "default"));

        let custom_q = QueueRecord {
            id: "work".into(),
            name: "Work Queue".into(),
            max_concurrent: 2,
            speed_limit_bytes_per_sec: Some(2_000_000),
            schedule_start: Some("09:00".into()),
            schedule_stop: Some("18:00".into()),
            schedule_days: Some("Mon,Tue,Wed,Thu,Fri".into()),
            post_action: "none".into(),
        };
        store.upsert_queue(&custom_q).expect("upsert queue failed");
        let updated_queues = store.list_queues().expect("list queues failed");
        assert_eq!(updated_queues.len(), 2);

        // Encrypted cookies test
        store.save_encrypted_cookies(id, b"encrypted_blob").expect("save cookies failed");
        let loaded_blob = store.get_encrypted_cookies(id).expect("get cookies failed");
        assert_eq!(loaded_blob, Some(b"encrypted_blob".to_vec()));
        store.purge_encrypted_cookies(id).expect("purge cookies failed");
        assert_eq!(store.get_encrypted_cookies(id).expect("get cookies failed"), None);

        // Duplicate test
        let dup = store.find_duplicate("https://example.com/file.iso", "other.iso", None).expect("find dup failed");
        assert!(dup.is_some());
    }
}
