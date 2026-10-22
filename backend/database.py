import os
import sqlite3
import json
import time
from typing import Dict, Any, List, Optional
from datetime import datetime

import sys

if getattr(sys, 'frozen', False):
    BASE_USER_DIR = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'VortexDownloader')
else:
    BASE_USER_DIR = os.path.dirname(os.path.abspath(__file__))

DB_DIR = os.path.join(BASE_USER_DIR, 'data')
os.makedirs(DB_DIR, exist_ok=True)
DB_PATH = os.path.join(DB_DIR, 'vortex.db')

def get_db_connection() -> sqlite3.Connection:
    """Create a thread-safe connection to SQLite with WAL mode enabled."""
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn

def init_db():
    """Initialize database tables with complete schemas."""
    with get_db_connection() as conn:
        conn.execute("""
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            title TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'DIRECT',
            target_extension TEXT NOT NULL DEFAULT 'bin',
            status TEXT NOT NULL DEFAULT 'queued',
            total_bytes INTEGER DEFAULT 0,
            downloaded_bytes INTEGER DEFAULT 0,
            progress REAL DEFAULT 0.0,
            speed TEXT DEFAULT '0.0 B/s',
            eta TEXT DEFAULT '--',
            file_path TEXT,
            format_id TEXT,
            resolution TEXT,
            threads INTEGER DEFAULT 16,
            chunks_json TEXT DEFAULT '[]',
            error_message TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMP
        );
        """)
        
        conn.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """)
        
        conn.execute("""
        CREATE TABLE IF NOT EXISTS vault (
            id TEXT PRIMARY KEY,
            task_id TEXT,
            original_name TEXT NOT NULL,
            encrypted_path TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        """)

        # Seed default settings if not exists
        default_download_dir = os.path.join(os.path.expanduser("~"), "Downloads", "Vortex")
        if not os.path.exists(default_download_dir):
            try:
                os.makedirs(default_download_dir, exist_ok=True)
            except Exception:
                default_download_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "temp_downloads")

        default_settings = {
            "default_threads": "16",
            "max_concurrent_downloads": "3",
            "auto_speed_boost": "true",
            "download_dir": default_download_dir,
            "conflict_policy": "keepboth",
            "proxy_enabled": "false",
            "proxy_type": "http",
            "proxy_host": "127.0.0.1",
            "proxy_port": "7890",
            "proxy_username": "",
            "proxy_password": "",
            "proxy_url": "",
            "auto_categorize_folders": "true",
            
            # Integration
            "protocol_vortex_enabled": "true",
            "assoc_torrent_enabled": "true",
            "assoc_magnet_enabled": "true",
            "assoc_ed2k_enabled": "false",
            "assoc_ftp_enabled": "false",
            "assoc_hls_enabled": "false",
            
            # Browser Extension
            "browser_extension_enabled": "true",
            "aria2_secret": "vortex-rpc-token-2026",
            
            # Personalization
            "theme_variant": "oled",
            "accent_color": "#3ea6ff",
            "sound_chimes_enabled": "true",
            "desktop_notifications_enabled": "true",
            
            # Legacy / System
            "keepalive_sleep": "true",
            "speed_limit_enabled": "false",
            "speed_limit_mbps": "0",
            "real_debrid_key": ""
        }
        for k, v in default_settings.items():
            conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?);", (k, v))
        conn.commit()

# --- Task Database Operations ---

def create_task(task_data: Dict[str, Any]) -> str:
    with get_db_connection() as conn:
        conn.execute("""
        INSERT INTO tasks (
            id, url, title, category, target_extension, status,
            total_bytes, downloaded_bytes, progress, speed, eta,
            file_path, format_id, resolution, threads, chunks_json, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        """, (
            task_data['id'],
            task_data['url'],
            task_data.get('title', 'Direct Download'),
            task_data.get('category', 'DIRECT'),
            task_data.get('target_extension', 'bin').lstrip('.'),
            task_data.get('status', 'queued'),
            task_data.get('total_bytes', 0),
            task_data.get('downloaded_bytes', 0),
            task_data.get('progress', 0.0),
            task_data.get('speed', '0.0 B/s'),
            task_data.get('eta', '--'),
            task_data.get('file_path'),
            task_data.get('format_id'),
            task_data.get('resolution'),
            task_data.get('threads', 16),
            json.dumps(task_data.get('chunks', [])),
            task_data.get('error_message')
        ))
        conn.commit()
    return task_data['id']

def get_task(task_id: str) -> Optional[Dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.execute("SELECT * FROM tasks WHERE id = ?;", (task_id,))
        row = cursor.fetchone()
        if not row:
            return None
        d = dict(row)
        try:
            d['chunks'] = json.loads(d.get('chunks_json') or '[]')
        except Exception:
            d['chunks'] = []
        return d

def update_task_progress(
    task_id: str,
    downloaded_bytes: int,
    total_bytes: int,
    progress: float,
    speed: str,
    eta: str,
    chunks: Optional[List[Dict[str, Any]]] = None
):
    with get_db_connection() as conn:
        if chunks is not None:
            conn.execute("""
            UPDATE tasks SET
                downloaded_bytes = ?,
                total_bytes = ?,
                progress = ?,
                speed = ?,
                eta = ?,
                chunks_json = ?
            WHERE id = ?;
            """, (downloaded_bytes, total_bytes, progress, speed, eta, json.dumps(chunks), task_id))
        else:
            conn.execute("""
            UPDATE tasks SET
                downloaded_bytes = ?,
                total_bytes = ?,
                progress = ?,
                speed = ?,
                eta = ?
            WHERE id = ?;
            """, (downloaded_bytes, total_bytes, progress, speed, eta, task_id))
        conn.commit()

def update_task_status(
    task_id: str,
    status: str,
    file_path: Optional[str] = None,
    error_message: Optional[str] = None
):
    with get_db_connection() as conn:
        params = [status]
        updates = ["status = ?"]
        
        if file_path:
            updates.append("file_path = ?")
            params.append(file_path)
            
        if error_message is not None:
            updates.append("error_message = ?")
            params.append(error_message)
            
        if status == 'completed':
            updates.append("completed_at = CURRENT_TIMESTAMP")
            updates.append("progress = 100.0")
            updates.append("speed = 'Completed'")
            updates.append("eta = '0s'")
            if file_path and os.path.exists(file_path):
                try:
                    fsize = os.path.getsize(file_path)
                    if fsize > 0:
                        updates.append("total_bytes = ?")
                        params.append(fsize)
                        updates.append("downloaded_bytes = ?")
                        params.append(fsize)
                except Exception:
                    pass
            
        params.append(task_id)
        conn.execute(f"UPDATE tasks SET {', '.join(updates)} WHERE id = ?;", params)
        conn.commit()

def list_tasks(filter_status: Optional[str] = None, search: Optional[str] = None) -> List[Dict[str, Any]]:
    query = "SELECT * FROM tasks"
    params = []
    conditions = []
    
    if filter_status:
        if filter_status == 'downloading':
            conditions.append("status IN ('downloading', 'queued')")
        elif filter_status == 'completed':
            conditions.append("status = 'completed'")
        elif filter_status == 'paused':
            conditions.append("status = 'paused'")
        elif filter_status == 'error':
            conditions.append("status = 'error'")
            
    if search:
        conditions.append("(title LIKE ? OR url LIKE ?)")
        s = f"%{search}%"
        params.extend([s, s])
        
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
        
    query += " ORDER BY created_at DESC;"
    
    with get_db_connection() as conn:
        cursor = conn.execute(query, params)
        rows = cursor.fetchall()
        tasks = []
        for r in rows:
            d = dict(r)
            try:
                d['chunks'] = json.loads(d.get('chunks_json') or '[]')
            except Exception:
                d['chunks'] = []
            tasks.append(d)
        return tasks

def delete_task(task_id: str) -> bool:
    with get_db_connection() as conn:
        cursor = conn.execute("DELETE FROM tasks WHERE id = ?;", (task_id,))
        conn.commit()
        return cursor.rowcount > 0

# --- Settings Operations ---

def get_all_settings() -> Dict[str, str]:
    with get_db_connection() as conn:
        cursor = conn.execute("SELECT key, value FROM settings;")
        return {row['key']: row['value'] for row in cursor.fetchall()}

def get_setting(key: str, default: str = "") -> str:
    with get_db_connection() as conn:
        cursor = conn.execute("SELECT value FROM settings WHERE key = ?;", (key,))
        row = cursor.fetchone()
        return row['value'] if row else default

def set_setting(key: str, value: str):
    with get_db_connection() as conn:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?);", (key, str(value)))
        conn.commit()

def update_settings(settings_dict: Dict[str, Any]):
    with get_db_connection() as conn:
        for k, v in settings_dict.items():
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?);", (k, str(v)))
        conn.commit()

# --- Vault Operations ---

def list_vault_items() -> List[Dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.execute("SELECT * FROM vault ORDER BY added_at DESC;")
        return [dict(r) for r in cursor.fetchall()]

def add_vault_item(item_id: str, original_name: str, encrypted_path: str, file_size: int, task_id: Optional[str] = None):
    with get_db_connection() as conn:
        conn.execute("""
        INSERT INTO vault (id, task_id, original_name, encrypted_path, file_size)
        VALUES (?, ?, ?, ?, ?);
        """, (item_id, task_id, original_name, encrypted_path, file_size))
        conn.commit()

def remove_vault_item(item_id: str) -> Optional[str]:
    with get_db_connection() as conn:
        cursor = conn.execute("SELECT encrypted_path FROM vault WHERE id = ?;", (item_id,))
        row = cursor.fetchone()
        if row:
            path = row['encrypted_path']
            conn.execute("DELETE FROM vault WHERE id = ?;", (item_id,))
            conn.commit()
            return path
        return None

# Initialize tables immediately on module load
init_db()
