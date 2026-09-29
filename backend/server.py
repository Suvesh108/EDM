import os
import sys
import json
import time
import asyncio
import random
import string
import re
from datetime import datetime, timezone
from typing import Dict, Any, Optional, List
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, Request, Response, BackgroundTasks, HTTPException, Query
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Internal Python modules
from downloader import extract_info, download_media
from chunk_downloader import SegmentedDownloader
from torrent_manager import torrent_manager
from accounts.account_manager import account_manager
from exporters.export_manager import ExportManager
from feature_packs.ftp_pack import FtpPack
from feature_packs.github_pack import GitHubPack
from feature_packs.huggingface_pack import HuggingFacePack
from feature_packs.ed2k_pack import Ed2kPack
from feature_packs.m3u8_pack import M3u8Pack
from feature_packs.yt_dlp_pack import YtDlpPack
from feature_packs.aria2_rpc import Aria2RpcService
from plugins.plugin_manager import plugin_manager
import keepalive

from contextlib import asynccontextmanager

def resolve_unique_path(directory: str, filename: str, policy: str = "rename") -> str:
    """Resolve file name conflicts according to policy ('overwrite', 'rename', 'skip')."""
    target = os.path.join(directory, filename)
    if policy == "overwrite" or not os.path.exists(target):
        return target
    base, ext = os.path.splitext(filename)
    counter = 1
    while os.path.exists(target):
        target = os.path.join(directory, f"{base} ({counter}){ext}")
        counter += 1
    return target

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMP_DIR = os.path.join(BASE_DIR, 'temp_downloads')
os.makedirs(TEMP_DIR, exist_ok=True)

# Periodic background cleaner
async def periodic_cleanup():
    while True:
        await asyncio.sleep(1800)  # 30 minutes
        try:
            now = time.time()
            max_age_s = 2 * 3600  # 2 hours
            for filename in os.listdir(TEMP_DIR):
                file_path = os.path.join(TEMP_DIR, filename)
                if os.path.isfile(file_path):
                    if now - os.path.getmtime(file_path) > max_age_s:
                        try:
                            os.remove(file_path)
                        except Exception:
                            pass
        except Exception:
            pass

@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(periodic_cleanup())
    yield
    task.cancel()

app = FastAPI(title="VortexDownloader Universal Engine", version="0.6.7", lifespan=lifespan)

# CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory job stores
jobs: Dict[str, Dict[str, Any]] = {}
chunk_jobs: Dict[str, Dict[str, Any]] = {}
chunk_event_queues: Dict[str, List[asyncio.Queue]] = {}
ftp_jobs: Dict[str, Dict[str, Any]] = {}

github_pack = GitHubPack()
huggingface_pack = HuggingFacePack()
ed2k_pack = Ed2kPack()
m3u8_pack = M3u8Pack()
yt_dlp_pack = YtDlpPack()
aria2_rpc_service = Aria2RpcService()

def is_valid_external_url(raw_url: str) -> bool:
    try:
        trimmed = raw_url.strip()
        if trimmed.startswith('magnet:?'):
            return True
        if trimmed.lower().startswith('ed2k://'):
            return True
        parsed = urlparse(trimmed)
        if parsed.scheme.lower() not in ('http', 'https', 'ftp', 'ftps'):
            return False
        host = (parsed.hostname or '').lower()
        if host in ('localhost', '127.0.0.1', '::1', '169.254.169.254') or host.endswith('.local') or host.endswith('.internal'):
            return False
        return True
    except Exception:
        return False

def add_job_log(job: Dict[str, Any], log_type: str, message: str):
    now = datetime.now()
    time_str = now.strftime("%H:%M:%S")
    log_id = ''.join(random.choices(string.ascii_lowercase + string.digits, k=7))
    job['logs'].append({
        'id': log_id,
        'time': time_str,
        'type': log_type,
        'message': message
    })

# 0. Health check
@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "VortexDownloader Universal Engine v0.6.7 (Python Core)"}

# Aria2 JSON-RPC 2.0 Compatibility Endpoint (for browser extensions)
@app.post("/jsonrpc")
@app.post("/api/jsonrpc")
async def handle_jsonrpc(req: Request):
    try:
        body = await req.json()
        return aria2_rpc_service.handle_request(body)
    except Exception as e:
        return {"jsonrpc": "2.0", "error": {"code": -32700, "message": f"Parse error: {str(e)}"}, "id": None}

# 1. Probe URL with TLS Impersonation (Bypasses Cloudflare / Anti-Bot)
@app.get("/api/probe")
async def probe(url: str = Query(...)):
    if not is_valid_external_url(url):
        raise HTTPException(status_code=400, detail="Valid URL is required.")

    if url.startswith("magnet:?"):
        return {
            "type": "torrent",
            "supportsRanges": False,
            "contentLength": 0,
            "contentType": "application/x-bittorrent",
            "isDirectFile": False
        }

    # 1. Try TLS-impersonated browser probe via curl_cffi
    try:
        from curl_cffi import requests as cffi_requests
        res = cffi_requests.head(url, impersonate="chrome120", timeout=10, allow_redirects=True)
        content_length = int(res.headers.get("content-length", 0))
        accept_ranges = res.headers.get("accept-ranges", "").lower() == "bytes"
        content_type = res.headers.get("content-type", "application/octet-stream")

        if content_length <= 0:
            try:
                res_range = cffi_requests.get(url, headers={"Range": "bytes=0-0"}, impersonate="chrome120", timeout=8)
                cr = res_range.headers.get("content-range", "")
                if "/" in cr:
                    content_length = int(cr.split("/")[-1])
                    accept_ranges = True
            except Exception:
                pass

        is_direct = content_length > 0 and "text/html" not in content_type.lower()
        return {
            "type": "direct" if is_direct else "stream",
            "supportsRanges": accept_ranges,
            "contentLength": content_length,
            "contentType": content_type,
            "isDirectFile": is_direct
        }
    except Exception:
        pass

    # 2. Secondary fallback via httpx
    try:
        async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
            res = await client.head(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134.0.0.0 Safari/537.36'})
            content_length = int(res.headers.get("content-length", 0))
            accept_ranges = res.headers.get("accept-ranges") == "bytes"
            content_type = res.headers.get("content-type", "application/octet-stream")
            is_direct = content_length > 0 and "text/html" not in content_type

            return {
                "type": "direct" if is_direct else "stream",
                "supportsRanges": accept_ranges,
                "contentLength": content_length,
                "contentType": content_type,
                "isDirectFile": is_direct
            }
    except Exception:
        return {
            "type": "stream",
            "supportsRanges": False,
            "contentLength": 0,
            "contentType": "unknown",
            "isDirectFile": False
        }

# 2. Extract Info (Supports 4K, 2K, 1080p, 720p and direct stream metadata)
@app.get("/api/info")
async def get_info(url: str = Query(...)):
    if not is_valid_external_url(url):
        raise HTTPException(status_code=400, detail="Valid HTTP/HTTPS URL parameter is required.")

    loop = asyncio.get_event_loop()
    try:
        # First try primary extractor
        data = await loop.run_in_executor(None, extract_info, url)
        if data and "error" not in data:
            return data

        # Fallback to extractor_service
        try:
            sys.path.insert(0, os.path.join(BASE_DIR, 'extractor'))
            from extractor_service import perform_extraction
            fallback_data = await loop.run_in_executor(None, perform_extraction, url)
            if fallback_data:
                return fallback_data
        except Exception:
            pass

        if data and "error" in data:
            raise HTTPException(status_code=400, detail=data["error"])
        raise HTTPException(status_code=500, detail="Failed to parse metadata.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to extract media metadata: {str(e)}")

# 3. Stream Extraction Download (Thread-Safe Callback Progress)
class DownloadPayload(BaseModel):
    url: str
    formatId: str
    title: str
    format: str
    conflictPolicy: Optional[str] = "rename"

@app.post("/api/download")
async def trigger_download(payload: DownloadPayload, background_tasks: BackgroundTasks):
    if not is_valid_external_url(payload.url):
        raise HTTPException(status_code=400, detail="Valid parameters required.")

    job_id = ''.join(random.choices(string.ascii_lowercase + string.digits, k=13))
    sanitized_title = re.sub(r'[^a-zA-Z0-9_-]', '_', payload.title)[:80]
    extension = re.sub(r'[^a-z0-9]', '', payload.format.lower())[:10] or 'mp4'
    file_name = f"{sanitized_title}_{job_id}.{extension}"
    file_path = resolve_unique_path(TEMP_DIR, file_name, payload.conflictPolicy or "rename")

    job = {
        'id': job_id,
        'url': payload.url,
        'formatId': payload.formatId,
        'title': sanitized_title,
        'extension': extension,
        'status': 'downloading',
        'progress': 0,
        'speed': '0.0 MB/s',
        'eta': '0s',
        'logs': [],
        'filePath': file_path,
        'error': None
    }
    jobs[job_id] = job
    add_job_log(job, 'info', f"Initialized extraction for job {job_id}")

    def on_job_progress(percent, speed, eta, status):
        job['progress'] = int(percent)
        job['speed'] = speed
        job['eta'] = eta
        if status == 'completed':
            job['status'] = 'completed'
            job['progress'] = 100
            add_job_log(job, 'success', 'Download finished.')
        elif status == 'stitching':
            job['progress'] = 99
            add_job_log(job, 'info', 'Multiplex container downloading completed. Compiling streams...')

    def run_download():
        keepalive.hold()
        try:
            download_media(payload.url, payload.formatId, file_path, progress_callback=on_job_progress)

            if job['status'] != 'completed' and not job.get('error'):
                if os.path.exists(file_path):
                    job['status'] = 'completed'
                    job['progress'] = 100
                    add_job_log(job, 'success', 'Download completed successfully.')
                else:
                    job['status'] = 'error'
                    job['error'] = 'Download did not produce expected output file.'
        except Exception as e:
            job['status'] = 'error'
            job['error'] = str(e)
            add_job_log(job, 'error', str(e))
        finally:
            keepalive.release()

    background_tasks.add_task(run_download)
    return {"jobId": job_id}

@app.get("/api/download/progress")
async def download_progress(jobId: str = Query(...)):
    job = jobs.get(jobId)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return {
        "status": job['status'],
        "progress": job['progress'],
        "speed": job['speed'],
        "eta": job['eta'],
        "logs": job['logs'],
        "error": job.get('error')
    }

@app.get("/api/download/file")
async def download_file(jobId: str = Query(...)):
    job = jobs.get(jobId)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    if job['status'] != 'completed' or not os.path.isfile(job['filePath']):
        raise HTTPException(status_code=400, detail="File is not ready or has been removed.")

    original_filename = f"{job['title']}.{job['extension']}"
    return FileResponse(
        path=job['filePath'],
        filename=original_filename,
        media_type="application/octet-stream"
    )

# 4. Chunk Downloader
class ChunkPayload(BaseModel):
    url: str
    title: Optional[str] = 'direct_file'
    threads: Optional[int] = 16
    destinationDir: Optional[str] = None
    conflictPolicy: Optional[str] = 'rename'

@app.post("/api/chunk-download")
async def chunk_download(payload: ChunkPayload, background_tasks: BackgroundTasks):
    if not is_valid_external_url(payload.url):
        raise HTTPException(status_code=400, detail="Valid direct URL is required.")

    job_id = 'chunk_' + ''.join(random.choices(string.ascii_lowercase + string.digits, k=10))
    clean_title = re.sub(r'[^a-zA-Z0-9_-]', '_', payload.title or 'direct_file')[:60]

    url_path = urlparse(payload.url).path
    ext = os.path.splitext(url_path)[1] or '.bin'
    file_name = f"{clean_title}_{job_id}{ext}"

    target_dir = TEMP_DIR
    is_direct_save = False
    if payload.destinationDir:
        try:
            os.makedirs(payload.destinationDir, exist_ok=True)
            target_dir = payload.destinationDir
            is_direct_save = True
        except Exception:
            target_dir = TEMP_DIR

    file_path = resolve_unique_path(target_dir, file_name, payload.conflictPolicy or 'rename')
    file_name = os.path.basename(file_path)

    initial_progress = {
        'totalBytes': 0,
        'downloadedBytes': 0,
        'percent': 0,
        'speed': '0.0 MB/s',
        'speedBytesPerSec': 0,
        'eta': '--',
        'chunks': [],
        'status': 'downloading'
    }

    def on_prog(p):
        if job_id in chunk_jobs:
            chunk_jobs[job_id]['progress'] = p
            # Dispatch to SSE queues
            for q in chunk_event_queues.get(job_id, []):
                try:
                    q.put_nowait(p)
                except Exception:
                    pass

    downloader = SegmentedDownloader(payload.url, file_path, threads=payload.threads or 16, on_progress=on_prog)

    chunk_jobs[job_id] = {
        'id': job_id,
        'url': payload.url,
        'title': clean_title,
        'fileName': file_name,
        'filePath': file_path,
        'downloader': downloader,
        'progress': initial_progress
    }

    async def run_chunk():
        keepalive.hold()
        try:
            await downloader.start()
        except Exception as e:
            if job_id in chunk_jobs:
                chunk_jobs[job_id]['progress']['status'] = 'error'
                chunk_jobs[job_id]['progress']['error'] = str(e)
                on_prog(chunk_jobs[job_id]['progress'])
        finally:
            keepalive.release()

    background_tasks.add_task(run_chunk)

    return {
        'jobId': job_id,
        'fileName': file_name,
        'filePath': file_path,
        'isDirectSave': is_direct_save,
        'status': 'downloading'
    }

@app.get("/api/chunk-download/progress")
async def chunk_progress(jobId: str = Query(...)):
    job = chunk_jobs.get(jobId)
    if not job:
        raise HTTPException(status_code=404, detail="Chunk job not found.")
    return {
        'jobId': job['id'],
        'fileName': job['fileName'],
        **job['progress']
    }

@app.get("/api/chunk-download/events/{job_id}")
async def chunk_events(job_id: str):
    if job_id not in chunk_jobs:
        raise HTTPException(status_code=404, detail="Chunk job not found.")

    queue: asyncio.Queue = asyncio.Queue()
    if job_id not in chunk_event_queues:
        chunk_event_queues[job_id] = []
    chunk_event_queues[job_id].append(queue)

    async def event_generator():
        current_job = chunk_jobs.get(job_id)
        if current_job:
            init_data = {'jobId': job_id, 'fileName': current_job['fileName'], **current_job['progress']}
            yield f"data: {json.dumps(init_data)}\n\n"

        try:
            while True:
                p = await queue.get()
                current_job = chunk_jobs.get(job_id)
                fn = current_job['fileName'] if current_job else ''
                data = {'jobId': job_id, 'fileName': fn, **p}
                yield f"data: {json.dumps(data)}\n\n"
                if p.get('status') in ('completed', 'error'):
                    break
        finally:
            if job_id in chunk_event_queues and queue in chunk_event_queues[job_id]:
                chunk_event_queues[job_id].remove(queue)

    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.get("/api/chunk-download/file")
async def chunk_file(jobId: str = Query(...)):
    job = chunk_jobs.get(jobId)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    if job['progress'].get('status') != 'completed' or not os.path.isfile(job['filePath']):
        raise HTTPException(status_code=400, detail="File is not ready or downloading.")

    return FileResponse(
        path=job['filePath'],
        filename=job['fileName'],
        media_type="application/octet-stream"
    )

# 5. BitTorrent Endpoints
class TorrentPayload(BaseModel):
    magnetURI: str

@app.post("/api/torrent/add")
async def add_torrent(payload: TorrentPayload):
    if not payload.magnetURI:
        raise HTTPException(status_code=400, detail="Valid magnetURI or torrent link required.")
    try:
        item = await torrent_manager.add_torrent(payload.magnetURI)
        return item
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/torrent/status")
async def torrent_status(infoHash: str = Query(...)):
    item = torrent_manager.get_torrent(infoHash)
    if not item:
        raise HTTPException(status_code=404, detail="Torrent not found.")
    return item

@app.get("/api/torrent/list")
async def torrent_list():
    return torrent_manager.list_torrents()

@app.delete("/api/torrent/{hash}")
async def delete_torrent(hash: str, deleteFiles: bool = False):
    deleted = torrent_manager.remove_torrent(hash, delete_files=deleteFiles)
    return {"success": deleted}

# 6. Feature Packs
@app.get("/api/packs")
async def get_packs():
    return [
        {
            "id": "http",
            "name": "HttpPack",
            "version": "v1.0.1",
            "description": "16-pipe IDM-style parallel multi-segmented chunk downloader",
            "author": "Ghost / Vortex Team",
            "enabled": True,
            "status": "active"
        },
        {
            "id": "ffmpeg",
            "name": "FFmpegPack",
            "version": "v1.0.1",
            "description": "Stream demuxing and audio/video transcoding",
            "author": "FFmpeg Org",
            "enabled": True,
            "status": "active"
        },
        {
            "id": "bittorrent",
            "name": "BitTorrentPack",
            "version": "v1.0.1",
            "description": "WebTorrent swarm engine, DHT tracker crawler, and peer-to-peer streaming",
            "author": "WebTorrent",
            "enabled": True,
            "status": "active"
        },
        {
            "id": "ed2k",
            "name": "ED2kPack",
            "version": "v1.2.1",
            "description": "eDonkey2000 URI parser, MD4 block hash verifier, and P2P gateway resolver",
            "author": "eDonkey / Ghost",
            "enabled": True,
            "status": "active"
        },
        {
            "id": "ftp",
            "name": "FtpPack",
            "version": "v1.0.1",
            "description": "FTP and FTPS secure remote file streaming with real-time speed & ETA telemetry",
            "author": "basic-ftp / Vortex",
            "enabled": True,
            "status": "active"
        },
        {
            "id": "github",
            "name": "GitHubPack",
            "version": "v1.0.0",
            "description": "GitHub Release binary inspector, tag resolver, and repository source downloader",
            "author": "GitHub Inc",
            "enabled": True,
            "status": "active"
        },
        {
            "id": "huggingface",
            "name": "HuggingFacePack",
            "version": "v1.0.1",
            "description": "AI model weights tree inspector (.safetensors, .gguf, .onnx) and CDN resolver",
            "author": "Hugging Face",
            "enabled": True,
            "status": "active"
        },
        {
            "id": "m3u8",
            "name": "M3U8Pack",
            "version": "v1.0.2",
            "description": "HLS adaptive bitrate playlist parser and segment multiplexer",
            "author": "Ghost Engine",
            "enabled": True,
            "status": "active"
        },
        {
            "id": "youtube",
            "name": "YouTubePack",
            "version": "v1.1.1",
            "description": "yt-dlp stream extraction for 4K/8K, HDR, WebM/Opus, and subtitle tracks",
            "author": "yt-dlp Project",
            "enabled": True,
            "status": "active"
        }
    ]

# 7. FTP Endpoints
class FtpPayload(BaseModel):
    url: str

@app.post("/api/ftp/download")
async def ftp_download(payload: FtpPayload, background_tasks: BackgroundTasks):
    if not payload.url or not (payload.url.startswith('ftp://') or payload.url.startswith('ftps://')):
        raise HTTPException(status_code=400, detail="Valid ftp:// or ftps:// URL is required.")

    pack = FtpPack()
    try:
        info = pack.parse_url(payload.url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    job_id = 'ftp_' + ''.join(random.choices(string.ascii_lowercase + string.digits, k=10))
    job = {
        'id': job_id,
        'url': payload.url,
        'fileName': info['fileName'],
        'filePath': os.path.join(TEMP_DIR, info['fileName']),
        'pack': pack,
        'progress': {
            'bytesDownloaded': 0,
            'totalBytes': 0,
            'percent': 0,
            'speed': '0.0 MB/s',
            'eta': '--'
        },
        'status': 'downloading',
        'error': None
    }
    ftp_jobs[job_id] = job

    def run_ftp():
        try:
            def on_p(p):
                if job_id in ftp_jobs:
                    ftp_jobs[job_id]['progress'] = p

            res = pack.download_file(payload.url, TEMP_DIR, on_progress=on_p)
            if job_id in ftp_jobs:
                ftp_jobs[job_id]['status'] = 'completed'
                ftp_jobs[job_id]['filePath'] = res['filePath']
        except Exception as e:
            if job_id in ftp_jobs:
                ftp_jobs[job_id]['status'] = 'error'
                ftp_jobs[job_id]['error'] = str(e)

    background_tasks.add_task(run_ftp)
    return {'jobId': job_id, 'fileName': info['fileName'], 'status': 'downloading'}

@app.get("/api/ftp/progress")
async def ftp_progress(jobId: str = Query(...)):
    job = ftp_jobs.get(jobId)
    if not job:
        raise HTTPException(status_code=404, detail="FTP job not found.")
    return {
        'jobId': job['id'],
        'fileName': job['fileName'],
        'status': job['status'],
        'error': job.get('error'),
        **job['progress']
    }

@app.get("/api/ftp/file")
async def ftp_file(jobId: str = Query(...)):
    job = ftp_jobs.get(jobId)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    if job['status'] != 'completed' or not os.path.isfile(job['filePath']):
        raise HTTPException(status_code=400, detail="File is not ready or downloading.")
    return FileResponse(
        path=job['filePath'],
        filename=job['fileName'],
        media_type="application/octet-stream"
    )

# 8. GitHub Pack
class UrlPayload(BaseModel):
    url: str

@app.post("/api/github/inspect")
async def github_inspect(payload: UrlPayload):
    parsed = github_pack.parse_url(payload.url)
    if not parsed.get('isGitHub'):
        raise HTTPException(status_code=400, detail="Not a recognized GitHub repository or release URL.")

    ptype = parsed.get('type')
    if ptype in ('raw', 'release-direct'):
        return {
            'type': 'direct',
            'directUrl': parsed.get('directUrl'),
            'owner': parsed.get('owner'),
            'repo': parsed.get('repo')
        }

    try:
        release = await github_pack.inspect_release(parsed.get('owner', ''), parsed.get('repo', ''), parsed.get('tag'))
        return {
            'type': 'release',
            'owner': parsed.get('owner'),
            'repo': parsed.get('repo'),
            'release': release
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/github/accelerate")
async def github_accelerate(url: str = Query(...)):
    if not is_valid_external_url(url):
        raise HTTPException(status_code=400, detail="Valid GitHub URL required.")
    return {"mirrors": github_pack.get_accelerated_urls(url)}

# 9. Hugging Face Pack
@app.post("/api/huggingface/inspect")
async def huggingface_inspect(payload: UrlPayload):
    parsed = huggingface_pack.parse_url(payload.url)
    if not parsed.get('isHuggingFace'):
        raise HTTPException(status_code=400, detail="Not a recognized Hugging Face model or dataset URL.")

    if parsed.get('isDirectFile') and parsed.get('directUrl'):
        return {
            'type': 'direct',
            'directUrl': parsed.get('directUrl'),
            'modelId': parsed.get('modelId'),
            'filePath': parsed.get('filePath')
        }

    try:
        model_info = await huggingface_pack.inspect_model(parsed.get('modelId', ''), parsed.get('revision', 'main'))
        return {
            'type': 'model',
            'modelInfo': model_info
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# 10. eD2k Pack
@app.post("/api/ed2k/inspect")
async def ed2k_inspect(payload: UrlPayload):
    info = ed2k_pack.parse_url(payload.url)
    if not info.get('isValid'):
        raise HTTPException(status_code=400, detail=info.get('error', 'Invalid eD2k URI.'))
    return {
        'type': 'ed2k',
        'info': info
    }

# 11. M3U8 Adaptive Streaming Pack
@app.post("/api/m3u8/inspect")
async def m3u8_inspect(payload: UrlPayload):
    if not is_valid_external_url(payload.url):
        raise HTTPException(status_code=400, detail="Valid URL required.")
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            res = await client.get(payload.url)
            if res.status_code != 200:
                raise HTTPException(status_code=res.status_code, detail="Failed to fetch m3u8 manifest")
            info = m3u8_pack.parse_manifest(res.text, payload.url)
            return {"type": "m3u8", **info}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# 11. Plugins
@app.get("/api/plugins")
async def list_plugins():
    return {"plugins": plugin_manager.list_plugins()}

@app.post("/api/plugins/resolve")
async def resolve_plugin(payload: UrlPayload):
    try:
        return await plugin_manager.resolve(payload.url)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# 12. Debrid / Accounts
@app.get("/api/accounts/list")
async def list_accounts():
    return {"accounts": account_manager.list_accounts()}

class DebridPayload(BaseModel):
    provider: str
    apiKey: str

@app.post("/api/accounts/debrid")
async def set_debrid(payload: DebridPayload):
    if payload.provider == 'real_debrid':
        verification = await account_manager.verify_real_debrid(payload.apiKey)
        if not verification.get('success'):
            raise HTTPException(status_code=400, detail=verification.get('error', 'Verification failed'))
        return {"success": True, **verification}

    account_manager.set_account({
        'provider': payload.provider,
        'apiKey': payload.apiKey,
        'status': 'active'
    })
    return {"success": True}

@app.delete("/api/accounts/debrid/{provider}")
async def remove_debrid(provider: str):
    account_manager.remove_account(provider)
    return {"success": True}

# 13. Exporters
def get_exportable_tasks() -> List[Dict[str, Any]]:
    return [
        {
            'url': j['url'],
            'fileName': j['fileName'],
            'fileSize': j['progress'].get('totalBytes') if j['progress'].get('totalBytes', 0) > 0 else None
        }
        for j in chunk_jobs.values()
    ]

@app.get("/api/export/curl")
async def export_curl():
    tasks = get_exportable_tasks()
    script = ExportManager.to_curl_script(tasks)
    return Response(
        content=script,
        media_type="text/x-shellscript",
        headers={"Content-Disposition": 'attachment; filename="vortex_downloads.sh"'}
    )

@app.get("/api/export/metalink")
async def export_metalink():
    tasks = get_exportable_tasks()
    xml = ExportManager.to_metalink(tasks)
    return Response(
        content=xml,
        media_type="application/metalink4+xml",
        headers={"Content-Disposition": 'attachment; filename="vortex_downloads.meta4"'}
    )

@app.get("/api/export/aria2")
async def export_aria2():
    tasks = get_exportable_tasks()
    txt = ExportManager.to_aria2_input(tasks)
    return Response(
        content=txt,
        media_type="text/plain",
        headers={"Content-Disposition": 'attachment; filename="vortex_aria2.txt"'}
    )

@app.get("/api/export/json")
async def export_json():
    tasks = get_exportable_tasks()
    data = ExportManager.to_json(tasks)
    return Response(
        content=data,
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="vortex_backup.json"'}
    )

# 14. aria2 JSON-RPC
async def handle_aria2_rpc(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}

    method = body.get("method")
    req_id = body.get("id", "1")
    params = body.get("params", [])

    real_params = params
    if isinstance(params, list) and params and isinstance(params[0], str) and params[0].startswith("token:"):
        real_params = params[1:]

    if method == "aria2.getVersion":
        return JSONResponse({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "version": "1.36.0",
                "enabledFeatures": ["Async DNS", "BitTorrent", "Firefox3 Cookie", "GZip", "HTTPS", "Message Digest", "Metalink", "XML-RPC"]
            }
        })

    if method == "aria2.addUri":
        uris = real_params[0] if real_params else []
        target_url = uris[0] if isinstance(uris, list) and uris else uris
        if not target_url or not is_valid_external_url(target_url):
            return JSONResponse({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": "Invalid URL"}}, status_code=400)

        gid = ''.join(random.choices(string.ascii_lowercase + string.digits, k=16))
        if target_url.startswith("magnet:?"):
            asyncio.create_task(torrent_manager.add_torrent(target_url))
        else:
            clean_title = 'aria2_task'
            file_name = f"{clean_title}_{gid}.bin"
            file_path = os.path.abspath(os.path.join(TEMP_DIR, file_name))
            downloader = SegmentedDownloader(target_url, file_path, threads=12)
            chunk_jobs[gid] = {
                'id': gid,
                'url': target_url,
                'title': clean_title,
                'fileName': file_name,
                'filePath': file_path,
                'downloader': downloader,
                'progress': {
                    'totalBytes': 0,
                    'downloadedBytes': 0,
                    'percent': 0,
                    'speed': '0.0 MB/s',
                    'speedBytesPerSec': 0,
                    'eta': '--',
                    'chunks': [],
                    'status': 'downloading'
                }
            }
            asyncio.create_task(downloader.start())

        return JSONResponse({"jsonrpc": "2.0", "id": req_id, "result": gid})

    if method == "aria2.tellStatus":
        gid = real_params[0] if real_params else ""
        chunk_job = chunk_jobs.get(gid)
        if chunk_job:
            prog = chunk_job['progress']
            return JSONResponse({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "gid": gid,
                    "status": "complete" if prog.get('status') == 'completed' else "active",
                    "totalLength": str(prog.get('totalBytes', 0)),
                    "completedLength": str(prog.get('downloadedBytes', 0)),
                    "downloadSpeed": str(int(prog.get('speedBytesPerSec', 0))),
                    "files": [{"path": chunk_job['filePath'], "length": str(prog.get('totalBytes', 0))}]
                }
            })
        return JSONResponse({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "gid": gid,
                "status": "active",
                "totalLength": "0",
                "completedLength": "0",
                "downloadSpeed": "0",
                "files": []
            }
        })

    if method == "aria2.tellActive":
        active_list = [
            {
                "gid": j['id'],
                "status": "active",
                "totalLength": str(j['progress'].get('totalBytes', 0)),
                "completedLength": str(j['progress'].get('downloadedBytes', 0)),
                "downloadSpeed": str(int(j['progress'].get('speedBytesPerSec', 0)))
            }
            for j in chunk_jobs.values()
            if j['progress'].get('status') == 'downloading'
        ]
        return JSONResponse({"jsonrpc": "2.0", "id": req_id, "result": active_list})

    return JSONResponse({"jsonrpc": "2.0", "id": req_id, "result": "OK"})

@app.post("/jsonrpc")
@app.post("/rpc")
@app.get("/jsonrpc")
async def aria2_rpc(request: Request):
    return await handle_aria2_rpc(request)

# 15. Static assets (Production frontend)
dist_path = os.path.join(BASE_DIR, 'dist')
if os.path.isdir(dist_path):
    app.mount("/", StaticFiles(directory=dist_path, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "5001"))
    print(f">> Vortex Universal Super-Engine running on http://localhost:{port}")
    print(f">> aria2 JSON-RPC available on http://localhost:{port}/jsonrpc")
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=False)
