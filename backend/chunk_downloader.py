import os
import time
import json
import asyncio
from typing import Callable, Optional, Dict, Any, List

def format_speed(bps: float) -> str:
    if bps <= 0:
        return '0.0 MB/s'
    for unit in ['B/s', 'KB/s', 'MB/s', 'GB/s']:
        if bps < 1024.0:
            return f"{bps:.1f} {unit}"
        bps /= 1024.0
    return f"{bps:.1f} TB/s"

def format_eta(seconds: float) -> str:
    if not seconds or seconds <= 0 or seconds > 86400:
        return '--'
    if seconds < 60:
        return f"{int(seconds)}s"
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f"{m}m {s}s"

class SegmentedDownloader:
    """
    IDM-grade multi-connection parallel chunk downloader.
    Features:
    - Thread-safe locked file writing (immune to Windows WinError 32 lock collisions)
    - Persistent resume state (.vrec binary/JSON records for instant pause & crash recovery)
    - Dynamic per-chunk auto-retry with exponential backoff
    - Throttled telemetry (prevents UI/event loop starvation)
    - Browser TLS/header impersonation to evade Cloudflare / bot heuristics
    """
    def __init__(
        self,
        url: str,
        output_path: str,
        threads: int = 16,
        on_progress: Optional[Callable[[Dict[str, Any]], None]] = None
    ):
        self.url = url
        self.output_path = os.path.abspath(output_path)
        self.record_path = self.output_path + ".vrec"
        self.threads = max(1, min(threads, 32))
        self.on_progress = on_progress
        self.is_cancelled = False
        self.total_bytes = 0
        self.downloaded_bytes = 0
        self.chunks: List[Dict[str, Any]] = []
        self.file_write_lock = asyncio.Lock()
        self.progress_lock = asyncio.Lock()
        self.last_time = time.time()
        self.last_downloaded = 0
        self.last_emit_time = 0.0
        self.last_save_time = 0.0
        self.speed_bps = 0.0
        self.work_stealing = True
        self.file_handle = None

    def cancel(self):
        self.is_cancelled = True

    def _save_record(self):
        try:
            data = {
                "url": self.url,
                "total_bytes": self.total_bytes,
                "chunks": [
                    {
                        "index": c["index"],
                        "start": c["start"],
                        "end": c["end"],
                        "current": c["current"],
                        "total": c["total"]
                    }
                    for c in self.chunks
                ]
            }
            tmp = self.record_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f)
            if os.path.exists(tmp):
                if os.path.exists(self.record_path):
                    os.replace(tmp, self.record_path)
                else:
                    os.rename(tmp, self.record_path)
        except Exception:
            pass

    def _try_load_record(self) -> bool:
        if os.path.exists(self.record_path) and os.path.exists(self.output_path):
            try:
                with open(self.record_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if data.get("url") == self.url and data.get("total_bytes") == self.total_bytes and data.get("chunks"):
                    self.chunks = data["chunks"]
                    self.downloaded_bytes = sum(c.get("current", 0) for c in self.chunks)
                    for c in self.chunks:
                        c["percent"] = int((c["current"] / c["total"]) * 100) if c.get("total", 0) > 0 else 0
                        c["status"] = "completed" if c["current"] >= c["total"] else "idle"
                    return True
            except Exception:
                pass
        return False

    def _delete_record(self):
        try:
            if os.path.exists(self.record_path):
                os.remove(self.record_path)
        except Exception:
            pass

    async def _emit_progress(self, status: str = 'downloading', error: Optional[str] = None, force: bool = False):
        if not self.on_progress:
            return

        now = time.time()
        if not force and status == 'downloading' and (now - self.last_emit_time < 0.2):
            return

        self.last_emit_time = now
        elapsed = now - self.last_time
        if elapsed >= 0.3 or status != 'downloading':
            diff = self.downloaded_bytes - self.last_downloaded
            self.speed_bps = diff / elapsed if elapsed > 0 else 0.0
            self.last_time = now
            self.last_downloaded = self.downloaded_bytes

        percent = int((self.downloaded_bytes / self.total_bytes) * 100) if self.total_bytes > 0 else 0
        rem_bytes = max(0, self.total_bytes - self.downloaded_bytes)
        eta_s = rem_bytes / self.speed_bps if self.speed_bps > 0 else 0

        p = {
            'totalBytes': self.total_bytes,
            'downloadedBytes': self.downloaded_bytes,
            'percent': 100 if status == 'completed' else min(99, percent),
            'speed': format_speed(self.speed_bps),
            'speedBytesPerSec': self.speed_bps,
            'eta': format_eta(eta_s) if status == 'downloading' else '--',
            'chunks': self.chunks,
            'status': status
        }
        if error:
            p['error'] = error

        self.on_progress(p)

    async def start(self) -> str:
        os.makedirs(os.path.dirname(self.output_path), exist_ok=True)
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Encoding': 'identity'
        }

        # 1. Probe URL for size and range support (using curl_cffi for bot bypass, falling back to httpx)
        supports_ranges = False
        try:
            from curl_cffi import requests as cffi_requests
            head_res = cffi_requests.head(self.url, headers=headers, impersonate="chrome120", timeout=10, allow_redirects=True)
            self.total_bytes = int(head_res.headers.get('content-length', 0))
            supports_ranges = head_res.headers.get('accept-ranges', '').lower() == 'bytes'
            if self.total_bytes <= 0:
                range_res = cffi_requests.get(self.url, headers={**headers, 'Range': 'bytes=0-0'}, impersonate="chrome120", timeout=8)
                cr = range_res.headers.get('content-range', '')
                if '/' in cr:
                    self.total_bytes = int(cr.split('/')[-1])
                    supports_ranges = True
        except Exception:
            pass

        if self.total_bytes <= 0:
            import httpx
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                try:
                    head_res = await client.head(self.url, headers=headers)
                    self.total_bytes = int(head_res.headers.get('content-length', 0))
                    supports_ranges = head_res.headers.get('accept-ranges') == 'bytes'
                except Exception:
                    pass

                if self.total_bytes <= 0:
                    try:
                        range_res = await client.get(self.url, headers={**headers, 'Range': 'bytes=0-0'})
                        cr = range_res.headers.get('content-range', '')
                        if '/' in cr:
                            self.total_bytes = int(cr.split('/')[-1])
                            supports_ranges = True
                    except Exception:
                        pass

        # 2. If ranges unsupported or unknown size, fallback to single-stream download
        if not supports_ranges or self.total_bytes <= 0:
            return await self._download_single()

        # 3. Check for existing partial download record (.vrec)
        is_resumed = self._try_load_record()
        if not is_resumed:
            # Partition file into chunks
            chunk_size = self.total_bytes // self.threads
            self.chunks = []
            for i in range(self.threads):
                start = i * chunk_size
                end = (self.total_bytes - 1) if (i == self.threads - 1) else (start + chunk_size - 1)
                total = end - start + 1
                self.chunks.append({
                    'index': i,
                    'start': start,
                    'end': end,
                    'current': 0,
                    'total': total,
                    'percent': 0,
                    'status': 'idle'
                })

            # Pre-allocate sparse placeholder file on disk
            with open(self.output_path, 'wb') as f:
                if self.total_bytes > 0:
                    f.seek(self.total_bytes - 1)
                    f.write(b'\0')
            self._save_record()

        self.last_time = time.time()
        self.last_downloaded = self.downloaded_bytes
        await self._emit_progress('downloading', force=True)

        # 4. Open single shared file handle for thread-safe locked writes
        self.file_handle = open(self.output_path, 'r+b')
        import httpx
        limits = httpx.Limits(max_keepalive_connections=self.threads, max_connections=self.threads)
        
        try:
            async with httpx.AsyncClient(timeout=60.0, limits=limits, follow_redirects=True) as client:
                tasks = [self._worker_loop(client, chunk) for chunk in self.chunks]
                await asyncio.gather(*tasks)
        finally:
            if self.file_handle:
                try:
                    self.file_handle.close()
                except Exception:
                    pass
                self.file_handle = None

        if self.is_cancelled:
            self._save_record()
            await self._emit_progress('error', 'Download paused/cancelled', force=True)
            raise Exception("Download cancelled")

        self._delete_record()
        await self._emit_progress('completed', force=True)
        return self.output_path

    async def _worker_loop(self, client: Any, chunk: Dict[str, Any]):
        """Executes assigned chunk and dynamically steals work from slower workers upon completion."""
        await self._download_chunk(client, chunk)

        # Dynamic Work-Stealing: When finished, steal remaining bytes from slowest chunks!
        while not self.is_cancelled:
            stolen = await self._steal_largest_range(chunk)
            if not stolen:
                break
            await self._download_chunk(client, chunk)

    async def _steal_largest_range(self, idle_chunk: Dict[str, Any]) -> bool:
        """Finds the chunk with the largest un-downloaded byte range and splits it in half."""
        MIN_SPLIT_SIZE = 512 * 1024  # 512 KB
        async with self.file_write_lock:
            best_target = None
            max_rem = 0
            for c in self.chunks:
                if c is idle_chunk:
                    continue
                rem = c['end'] - (c['start'] + c['current']) + 1
                if rem > max_rem:
                    max_rem = rem
                    best_target = c

            if not best_target or max_rem < MIN_SPLIT_SIZE:
                return False

            # Split the remaining range in half
            split_point = (best_target['start'] + best_target['current']) + (max_rem // 2)
            original_end = best_target['end']

            # Shrink target's end
            best_target['end'] = split_point - 1
            best_target['total'] = best_target['end'] - best_target['start'] + 1
            best_target['percent'] = int((best_target['current'] / best_target['total']) * 100) if best_target['total'] > 0 else 100

            # Reconfigure idle worker with the stolen upper half
            idle_chunk['start'] = split_point
            idle_chunk['end'] = original_end
            idle_chunk['current'] = 0
            idle_chunk['total'] = idle_chunk['end'] - idle_chunk['start'] + 1
            idle_chunk['percent'] = 0
            idle_chunk['status'] = 'downloading'

            self._save_record()
            return True

    async def _download_chunk(self, client: Any, chunk: Dict[str, Any]):
        if self.is_cancelled:
            return

        if chunk['current'] >= chunk['total']:
            chunk['status'] = 'completed'
            return

        retries = 5
        for attempt in range(retries):
            if self.is_cancelled:
                return

            chunk['status'] = 'downloading'
            current_start = chunk['start'] + chunk['current']
            if current_start > chunk['end']:
                chunk['status'] = 'completed'
                return

            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
                'Range': f"bytes={current_start}-{chunk['end']}",
                'Accept': '*/*',
                'Accept-Encoding': 'identity'
            }

            try:
                async with client.stream('GET', self.url, headers=headers) as response:
                    if response.status_code not in (200, 206):
                        raise Exception(f"HTTP {response.status_code}")

                    async for part in response.aiter_bytes(chunk_size=64 * 1024):
                        if self.is_cancelled:
                            break
                        part_len = len(part)
                        
                        # Thread-safe write to pre-allocated file position
                        async with self.file_write_lock:
                            if self.file_handle and not self.file_handle.closed:
                                self.file_handle.seek(chunk['start'] + chunk['current'])
                                self.file_handle.write(part)

                        chunk['current'] += part_len
                        chunk['percent'] = int((chunk['current'] / chunk['total']) * 100)
                        
                        async with self.progress_lock:
                            self.downloaded_bytes += part_len

                        # Throttled emit
                        await self._emit_progress('downloading')

                        # Save resume record every 3 seconds
                        now = time.time()
                        if now - self.last_save_time > 3.0:
                            self.last_save_time = now
                            self._save_record()

                if chunk['current'] >= chunk['total']:
                    chunk['status'] = 'completed'
                    return
            except Exception as e:
                if attempt == retries - 1:
                    chunk['status'] = 'error'
                    raise e
                await asyncio.sleep(1.0 * (attempt + 1))

    async def _download_single(self) -> str:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
            'Accept': '*/*'
        }
        self.chunks = [{
            'index': 0,
            'start': 0,
            'end': self.total_bytes,
            'current': 0,
            'total': self.total_bytes,
            'percent': 0,
            'status': 'downloading'
        }]

        import httpx
        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
            async with client.stream('GET', self.url, headers=headers) as response:
                with open(self.output_path, 'wb') as f:
                    async for part in response.aiter_bytes(chunk_size=64 * 1024):
                        if self.is_cancelled:
                            raise Exception("Download cancelled")
                        f.write(part)
                        part_len = len(part)
                        self.downloaded_bytes += part_len
                        self.chunks[0]['current'] = self.downloaded_bytes
                        if self.total_bytes > 0:
                            self.chunks[0]['percent'] = int((self.downloaded_bytes / self.total_bytes) * 100)
                        await self._emit_progress('downloading')

        self._delete_record()
        await self._emit_progress('completed', force=True)
        return self.output_path
