import os
import sys
import asyncio
import time
from typing import Dict, Any, Optional

from database import (
    create_task, get_task, update_task_progress,
    update_task_status, list_tasks, get_setting
)
from engine.chunk_downloader import SegmentedDownloader
from engine.yt_extractor import download_stream
import keepalive
from logger import add_core_log

class DownloadQueueManager:
    """
    Centralized High-Concurrency Queue Orchestrator for Vortex Downloader.
    
    Features:
    - Semaphore-based concurrency limiting (default 3, dynamically reconfigurable).
    - Task reconciliation: converts interrupted downloads to 'paused' on server startup.
    - Uniform task lifecycle handling across yt-dlp, segmented chunk downloader, and cloud streams.
    - Atomic database progress persistence with rolling speed telemetry.
    - OS sleep prevention integration (Windows SetThreadExecutionState).
    """
    def __init__(self):
        max_concurrent = int(get_setting("max_concurrent_downloads", "3"))
        self.semaphore = asyncio.Semaphore(max_concurrent)
        self.active_downloaders: Dict[str, Any] = {}
        self.cancel_flags: Dict[str, bool] = {}
        self.running_tasks: Dict[str, asyncio.Task] = {}

    def reconcile_interrupted_tasks(self):
        """Recover tasks that were interrupted by a process termination or reboot."""
        try:
            tasks = list_tasks()
            for t in tasks:
                if t['status'] == 'downloading':
                    # Mark as paused so the user can 1-click resume
                    update_task_status(t['id'], 'paused', error_message="Interrupted by server reboot. Ready to resume.")
        except Exception:
            pass

    async def submit_task(self, task_data: Dict[str, Any]) -> str:
        task_id = create_task(task_data)
        asyncio.create_task(self._task_pipeline(task_id))
        return task_id

    async def pause_task(self, task_id: str):
        self.cancel_flags[task_id] = True
        downloader = self.active_downloaders.get(task_id)
        if downloader and hasattr(downloader, 'pause'):
            downloader.pause()
        update_task_status(task_id, 'paused')

    async def resume_task(self, task_id: str):
        task = get_task(task_id)
        if not task:
            return
        update_task_status(task_id, 'queued')
        self.cancel_flags[task_id] = False
        asyncio.create_task(self._task_pipeline(task_id))

    async def cancel_task(self, task_id: str):
        self.cancel_flags[task_id] = True
        downloader = self.active_downloaders.get(task_id)
        if downloader and hasattr(downloader, 'cancel'):
            downloader.cancel()
        update_task_status(task_id, 'paused', error_message="Cancelled by user")

    async def start_all(self):
        tasks = list_tasks()
        for t in tasks:
            if t['status'] in ('paused', 'error'):
                await self.resume_task(t['id'])

    async def pause_all(self):
        for task_id in list(self.active_downloaders.keys()):
            await self.pause_task(task_id)

    async def _task_pipeline(self, task_id: str):
        task = get_task(task_id)
        if not task:
            return

        async with self.semaphore:
            # Check if cancelled before starting
            if self.cancel_flags.get(task_id):
                self.cancel_flags[task_id] = False
                return

            category = task.get('category', 'DIRECT')
            url = task['url']
            file_path = task['file_path']
            threads = task.get('threads', 16)
            format_id = task.get('format_id') or 'best'

            update_task_status(task_id, 'downloading')
            keepalive.hold()
            add_core_log("stage", f"Download dispatched: {task.get('title')} [{threads} Pipes]")
            
            try:

                # Progress forwarder callback
                def on_chunk_progress(p: Dict[str, Any]):
                    update_task_progress(
                        task_id,
                        downloaded_bytes=p.get('downloadedBytes', 0),
                        total_bytes=p.get('totalBytes', 0),
                        progress=p.get('percent', 0.0),
                        speed=p.get('speed', '0.0 B/s'),
                        eta=p.get('eta', '--'),
                        chunks=p.get('chunks')
                    )

                def on_yt_progress(percent: float, speed: str, eta: str, status_label: str, down_bytes: int = 0, tot_bytes: int = 0):
                    task_curr = get_task(task_id)
                    tot = tot_bytes if tot_bytes > 0 else (task_curr.get('total_bytes', 0) if task_curr else 0)
                    down = down_bytes if down_bytes > 0 else (int(tot * (percent / 100.0)) if tot > 0 else 0)
                    update_task_progress(
                        task_id,
                        downloaded_bytes=down,
                        total_bytes=tot,
                        progress=percent,
                        speed=speed,
                        eta=eta
                    )

                # Route based on download type
                if category == 'VIDEO' and not url.lower().endswith(('.mp4', '.mkv', '.webm', '.ts', '.m3u8')):
                    # Use universal yt-dlp pipeline
                    loop = asyncio.get_event_loop()
                    self.cancel_flags[task_id] = False
                    
                    def run_yt():
                        download_stream(
                            url=url,
                            format_id=format_id,
                            output_path=file_path,
                            progress_callback=on_yt_progress,
                            cancel_flag=lambda: self.cancel_flags.get(task_id, False)
                        )

                    await loop.run_in_executor(None, run_yt)
                    update_task_status(task_id, 'completed', file_path=file_path)
                    add_core_log("success", f"Completed media mux: {task.get('title')}")
                else:
                    # Use Segmented Chunk Downloader (Dynamic Halving Work-Stealing)
                    downloader = SegmentedDownloader(
                        url=url,
                        output_path=file_path,
                        threads=threads,
                        on_progress=on_chunk_progress
                    )
                    self.active_downloaders[task_id] = downloader
                    final_path = await downloader.start()
                    update_task_status(task_id, 'completed', file_path=final_path)
                    add_core_log("success", f"Completed multi-pipe download: {task.get('title')}")

            except Exception as e:
                err = str(e)
                if 'cancelled' in err.lower() or 'paused' in err.lower():
                    update_task_status(task_id, 'paused')
                    add_core_log("info", f"Task paused: {task.get('title')}")
                else:
                    update_task_status(task_id, 'error', error_message=err)
                    add_core_log("error", f"Task failed: {task.get('title')} - {err}")
            finally:
                if task_id in self.active_downloaders:
                    del self.active_downloaders[task_id]
                keepalive.release()

queue_manager = DownloadQueueManager()
