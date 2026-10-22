import os
import sys
import time
import json
import asyncio
from typing import Callable, Optional, Dict, Any, List

def format_speed(bps: float) -> str:
    if bps <= 0:
        return '0.0 B/s'
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
    IDM-Grade Dynamic Multi-Connection Segmented Downloader.
    
    Features:
    - Pre-allocation of sparse disk files (eliminates fragmented file writes).
    - True Dynamic Halving Work-Stealing: idle threads continuously steal half of the slowest worker's remaining chunk.
    - Independent non-overlapping file seek/write (zero lock contention on Windows NTFS).
    - Crash-resilient .vrec journal for pause & resume.
    - Anti-bot browser headers & TLS impersonation.
    - Rolling window smoothed telemetry.
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
        self.is_paused = False
        self.fatal_error: Optional[str] = None
        self.total_bytes = 0
        self.downloaded_bytes = 0
        self.chunks: List[Dict[str, Any]] = []
        
        # Concurrency & Work Stealing locks
        self.split_lock = asyncio.Lock()
        self.progress_lock = asyncio.Lock()
        
        # Telemetry
        self.start_time = time.time()
        self.last_time = time.time()
        self.last_downloaded = 0
        self.last_emit_time = 0.0
        self.speed_bps = 0.0
        self.speed_samples: List[float] = []

    def cancel(self):
        self.is_cancelled = True

    def pause(self):
        self.is_paused = True
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
                        "total": c["total"],
                        "status": c.get("status", "idle")
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
        if not force and status == 'downloading' and (now - self.last_emit_time < 0.25):
            return

        self.last_emit_time = now
        elapsed = now - self.last_time
        if elapsed >= 0.3 or status != 'downloading':
            diff = self.downloaded_bytes - self.last_downloaded
            instant_speed = diff / elapsed if elapsed > 0 else 0.0
            self.speed_samples.append(instant_speed)
            if len(self.speed_samples) > 5:
                self.speed_samples.pop(0)
            self.speed_bps = sum(self.speed_samples) / len(self.speed_samples)
            self.last_time = now
            self.last_downloaded = self.downloaded_bytes

        percent = (self.downloaded_bytes / self.total_bytes * 100.0) if self.total_bytes > 0 else 0.0
        rem_bytes = max(0, self.total_bytes - self.downloaded_bytes)
        eta_s = rem_bytes / self.speed_bps if self.speed_bps > 0 else 0

        p = {
            'totalBytes': self.total_bytes,
            'downloadedBytes': self.downloaded_bytes,
            'percent': 100.0 if status == 'completed' else round(min(99.9, percent), 1),
            'speed': format_speed(self.speed_bps),
            'speedBytesPerSec': self.speed_bps,
            'eta': format_eta(eta_s) if status == 'downloading' else '--',
            'chunks': self.chunks,
            'status': status
        }
        if error:
            p['error'] = error

        self.on_progress(p)

    async def _find_work_to_steal(self) -> Optional[Dict[str, Any]]:
        """IDM Dynamic Halving: Finds the chunk with the largest remaining work and splits it."""
        async with self.split_lock:
            best_chunk = None
            max_remaining = 0
            
            # Minimum threshold to split: 2MB remaining
            MIN_SPLIT_BYTES = 2 * 1024 * 1024

            for c in self.chunks:
                if c.get('status') == 'downloading':
                    remaining = c['end'] - (c['start'] + c['current'])
                    if remaining > max_remaining and remaining > MIN_SPLIT_BYTES:
                        max_remaining = remaining
                        best_chunk = c

            if not best_chunk:
                return None

            # Split remaining range in half
            current_pos = best_chunk['start'] + best_chunk['current']
            half = max_remaining // 2
            split_point = current_pos + half

            original_end = best_chunk['end']
            best_chunk['end'] = split_point
            best_chunk['total'] = best_chunk['end'] - best_chunk['start'] + 1

            new_chunk_idx = len(self.chunks)
            new_chunk = {
                'index': new_chunk_idx,
                'start': split_point + 1,
                'end': original_end,
                'current': 0,
                'total': original_end - (split_point + 1) + 1,
                'percent': 0,
                'status': 'idle'
            }
            self.chunks.append(new_chunk)
            self._save_record()
            return new_chunk

    async def _worker_loop(self, client: Any, chunk: Dict[str, Any]):
        """Dedicated worker executing byte ranges with dynamic work-stealing fallback."""
        current_chunk = chunk
        
        while current_chunk and not self.is_cancelled:
            if current_chunk['current'] >= current_chunk['total']:
                current_chunk['status'] = 'completed'
                current_chunk = await self._find_work_to_steal()
                continue

            current_chunk['status'] = 'downloading'
            req_start = current_chunk['start'] + current_chunk['current']
            req_end = current_chunk['end']

            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
                'Range': f'bytes={req_start}-{req_end}',
                'Accept': '*/*',
                'Connection': 'keep-alive'
            }

            try:
                # Open separate file handle for non-overlapping seek/write
                with open(self.output_path, 'r+b') as f:
                    async with client.stream("GET", self.url, headers=headers) as res:
                        if res.status_code in (401, 403, 404, 410):
                            self.fatal_error = f"HTTP {res.status_code} - Target resource inaccessible"
                            self.is_cancelled = True
                            return
                        if res.status_code not in (200, 206):
                            raise Exception(f"HTTP {res.status_code}")

                        async for data in res.aiter_bytes(chunk_size=65536):
                            if self.is_cancelled:
                                break

                            data_len = len(data)
                            write_pos = current_chunk['start'] + current_chunk['current']
                            f.seek(write_pos)
                            f.write(data)

                            current_chunk['current'] += data_len
                            async with self.progress_lock:
                                self.downloaded_bytes += data_len

                            if current_chunk['total'] > 0:
                                current_chunk['percent'] = int((current_chunk['current'] / current_chunk['total']) * 100)

                            await self._emit_progress('downloading')

                if current_chunk['current'] >= current_chunk['total']:
                    current_chunk['status'] = 'completed'
                    self._save_record()

            except Exception as e:
                retries = current_chunk.get('retries', 0) + 1
                current_chunk['retries'] = retries
                if retries >= 3:
                    self.fatal_error = f"Worker failed on chunk #{current_chunk.get('index', 0)}: {str(e)}"
                    self.is_cancelled = True
                    return
                current_chunk['status'] = 'idle'
                await asyncio.sleep(1.0) # brief backoff

            # Steal more work if available
            current_chunk = await self._find_work_to_steal()

    async def _download_single(self) -> str:
        """Fallback for servers that reject Range requests or don't report size."""
        import httpx
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
            'Accept': '*/*'
        }
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            async with client.stream("GET", self.url, headers=headers) as res:
                if res.status_code != 200:
                    raise Exception(f"Single download failed with HTTP {res.status_code}")
                
                cl = res.headers.get('content-length')
                if cl:
                    self.total_bytes = int(cl)

                with open(self.output_path, 'wb') as f:
                    async for data in res.aiter_bytes(chunk_size=65536):
                        if self.is_cancelled:
                            break
                        f.write(data)
                        self.downloaded_bytes += len(data)
                        await self._emit_progress('downloading')

        if self.is_cancelled:
            if self.is_paused:
                await self._emit_progress('paused', force=True)
            else:
                await self._emit_progress('error', 'Download cancelled', force=True)
            raise Exception("Download cancelled")

        await self._emit_progress('completed', force=True)
        return self.output_path

    async def start(self) -> str:
        os.makedirs(os.path.dirname(self.output_path), exist_ok=True)
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Encoding': 'identity'
        }

        # 1. Probe URL for size and range support
        supports_ranges = False
        proxy_url = None
        try:
            from database import get_setting
            if get_setting("proxy_enabled", "false").lower() in ("true", "1"):
                p_url = get_setting("proxy_url", "").strip()
                if not p_url:
                    ptype = get_setting("proxy_type", "http")
                    phost = get_setting("proxy_host", "127.0.0.1")
                    pport = get_setting("proxy_port", "7890")
                    puser = get_setting("proxy_username", "")
                    ppass = get_setting("proxy_password", "")
                    if puser and ppass:
                        p_url = f"{ptype}://{puser}:{ppass}@{phost}:{pport}"
                    else:
                        p_url = f"{ptype}://{phost}:{pport}"
                proxy_url = p_url
        except Exception:
            pass

        proxies_dict = {'http': proxy_url, 'https': proxy_url} if proxy_url else None

        try:
            from curl_cffi import requests as cffi_requests
            head_res = cffi_requests.head(self.url, headers=headers, impersonate="chrome120", timeout=10, allow_redirects=True, proxies=proxies_dict)
            if head_res.status_code in (401, 403, 404, 410):
                raise Exception(f"HTTP {head_res.status_code} - Target resource inaccessible")
            if head_res.status_code in (200, 206):
                self.total_bytes = int(head_res.headers.get('content-length', 0))
                supports_ranges = head_res.headers.get('accept-ranges', '').lower() == 'bytes'
            if self.total_bytes <= 0:
                range_res = cffi_requests.get(self.url, headers={**headers, 'Range': 'bytes=0-0'}, impersonate="chrome120", timeout=8, proxies=proxies_dict)
                if range_res.status_code in (200, 206):
                    cr = range_res.headers.get('content-range', '')
                    if '/' in cr:
                        self.total_bytes = int(cr.split('/')[-1])
                        supports_ranges = True
        except Exception as e:
            if "HTTP 4" in str(e):
                raise e

        if self.total_bytes <= 0:
            import httpx
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True, proxy=proxy_url) as client:
                try:
                    head_res = await client.head(self.url, headers=headers)
                    if head_res.status_code in (401, 403, 404, 410):
                        raise Exception(f"HTTP {head_res.status_code} - Target resource inaccessible")
                    if head_res.status_code in (200, 206):
                        self.total_bytes = int(head_res.headers.get('content-length', 0))
                        supports_ranges = head_res.headers.get('accept-ranges') == 'bytes'
                except Exception as e:
                    if "HTTP 4" in str(e):
                        raise e

                if self.total_bytes <= 0:
                    try:
                        range_res = await client.get(self.url, headers={**headers, 'Range': 'bytes=0-0'})
                        cr = range_res.headers.get('content-range', '')
                        if '/' in cr:
                            self.total_bytes = int(cr.split('/')[-1])
                            supports_ranges = True
                    except Exception:
                        pass

        # If no range support or size zero, use single stream
        if not supports_ranges or self.total_bytes <= 0:
            return await self._download_single()

        # 2. Setup or Resume Segments
        is_resumed = self._try_load_record()
        if not is_resumed:
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

            # Pre-allocate sparse placeholder file
            with open(self.output_path, 'wb') as f:
                if self.total_bytes > 0:
                    f.seek(self.total_bytes - 1)
                    f.write(b'\0')
            self._save_record()

        self.last_time = time.time()
        self.last_downloaded = self.downloaded_bytes
        await self._emit_progress('downloading', force=True)

        # 3. Launch Workers with Optional Intelligent Auto Speed Boost
        auto_boost = True
        try:
            from database import get_setting
            auto_boost = get_setting("auto_speed_boost", "true").lower() in ("true", "1")
        except Exception:
            pass

        import httpx
        limits = httpx.Limits(max_keepalive_connections=self.threads * 4, max_connections=self.threads * 4)
        async with httpx.AsyncClient(timeout=60.0, limits=limits, follow_redirects=True, proxy=proxy_url) as client:
            worker_tasks = [
                asyncio.create_task(self._worker_loop(client, self.chunks[i]))
                for i in range(min(self.threads, len(self.chunks)))
            ]

            async def _auto_boost_loop():
                max_pipes = min(64, max(self.threads * 2, 32))
                while not self.is_cancelled and not self.is_paused and self.downloaded_bytes < self.total_bytes:
                    await asyncio.sleep(2.0)
                    if len(worker_tasks) < max_pipes:
                        stolen = await self._find_work_to_steal()
                        if stolen:
                            task = asyncio.create_task(self._worker_loop(client, stolen))
                            worker_tasks.append(task)

            boost_task = asyncio.create_task(_auto_boost_loop()) if auto_boost else None
            try:
                await asyncio.gather(*worker_tasks)
            finally:
                if boost_task:
                    boost_task.cancel()

        if self.fatal_error:
            self._save_record()
            await self._emit_progress('error', self.fatal_error, force=True)
            raise Exception(self.fatal_error)

        if self.is_cancelled:
            self._save_record()
            if self.is_paused:
                await self._emit_progress('paused', force=True)
            else:
                await self._emit_progress('error', 'Download paused/cancelled', force=True)
            raise Exception("Download cancelled or paused")

        self._delete_record()
        await self._emit_progress('completed', force=True)
        return self.output_path
