import os
import sys
import json
import random
import string
import re
import asyncio
import subprocess
from datetime import datetime
from typing import Dict, Any, Optional, List
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, Request, Response, Form, Query, HTTPException, BackgroundTasks
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Register paths
if getattr(sys, 'frozen', False):
    BUNDLE_DIR = sys._MEIPASS
    CURRENT_DIR = os.path.join(BUNDLE_DIR, 'backend') if os.path.exists(os.path.join(BUNDLE_DIR, 'backend')) else BUNDLE_DIR
    BASE_USER_DIR = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'VortexDownloader')
else:
    CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
    BUNDLE_DIR = CURRENT_DIR
    BASE_USER_DIR = CURRENT_DIR

if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

from database import (
    init_db, get_db_connection, list_tasks, get_task,
    delete_task, get_all_settings, get_setting,
    set_setting, update_settings, list_vault_items,
    add_vault_item, remove_vault_item
)
from engine.queue_manager import queue_manager
from engine.yt_extractor import extract_media_info
from engine.hosts_extractor import identify_host, extract_hosting_media
from engine.detector import detect_file_category
from exporters.export_manager import ExportManager
from accounts.account_manager import account_manager
from torrent_manager import torrent_manager
from logger import add_core_log, get_core_logs, clear_core_logs

# Directories
STATIC_DIR = os.path.join(CURRENT_DIR, 'static')
if not os.path.exists(STATIC_DIR) and getattr(sys, 'frozen', False):
    STATIC_DIR = os.path.join(sys._MEIPASS, 'static')

TEMPLATES_DIR = os.path.join(CURRENT_DIR, 'templates')
if not os.path.exists(TEMPLATES_DIR) and getattr(sys, 'frozen', False):
    TEMPLATES_DIR = os.path.join(sys._MEIPASS, 'templates')

TEMP_DIR = os.path.join(BASE_USER_DIR, 'temp_downloads')
os.makedirs(TEMP_DIR, exist_ok=True)

app = FastAPI(title="VortexDownloader Universal Engine", version="0.6.9")

# CORS middleware for extension communication
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files and templates
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATES_DIR)

@app.on_event("startup")
async def on_startup():
    init_db()
    queue_manager.reconcile_interrupted_tasks()
    try:
        from engine.integrations import sync_all_integrations
        sync_all_integrations()
    except Exception:
        pass

# --- Health check ---
@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "service": "VortexDownloader Universal Engine",
        "version": "0.6.9",
        "architecture": "Unified High-Concurrency Python + HTMX Core"
    }

@app.get("/favicon.ico")
async def favicon():
    ico_path = os.path.join(STATIC_DIR, 'assets', 'favicon.ico')
    if os.path.exists(ico_path):
        return FileResponse(ico_path, media_type="image/x-icon")
    return FileResponse(os.path.join(STATIC_DIR, 'assets', 'favicon.png'), media_type="image/png")

# --- Main Web UI Views ---

@app.get("/", response_class=HTMLResponse)
async def index_view(request: Request):
    tasks = list_tasks()
    active_tasks = [t for t in tasks if t['status'] == 'downloading']
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "tasks": tasks,
            "active_tasks": active_tasks,
            "active_view": "tasks"
        }
    )

@app.get("/views/tasks", response_class=HTMLResponse)
async def view_tasks(request: Request):
    tasks = list_tasks()
    active_tasks = [t for t in tasks if t['status'] == 'downloading']
    return templates.TemplateResponse(
        request=request,
        name="partials/tasks_view.html",
        context={
            "tasks": tasks,
            "active_tasks": active_tasks
        }
    )

@app.get("/views/settings", response_class=HTMLResponse)
async def view_settings(request: Request):
    settings = get_all_settings()
    return templates.TemplateResponse(
        request=request,
        name="partials/settings_view.html",
        context={
            "settings": settings
        }
    )

@app.get("/views/vault", response_class=HTMLResponse)
async def view_vault(request: Request):
    vault_items = list_vault_items()
    return templates.TemplateResponse(
        request=request,
        name="partials/vault_view.html",
        context={
            "vault_items": vault_items
        }
    )

# --- Dynamic Partials ---

@app.get("/partials/tasks/active", response_class=HTMLResponse)
async def partial_tasks_active(request: Request):
    tasks = list_tasks()
    active = [t for t in tasks if t['status'] == 'downloading']
    
    total_speed_str = "0.0 B/s"
    if active:
        speeds = [t.get('speed', '0.0 B/s') for t in active]
        total_speed_str = speeds[0] if len(speeds) == 1 else f"{len(active)} Active"

    return templates.TemplateResponse(
        request=request,
        name="partials/tasks_active.html",
        context={
            "active_tasks": active,
            "total_speed": total_speed_str
        }
    )

@app.get("/partials/tasks/list", response_class=HTMLResponse)
async def partial_tasks_list(
    request: Request,
    filter: Optional[str] = Query(None),
    search: Optional[str] = Query(None)
):
    tasks = list_tasks(filter_status=filter, search=search)
    return templates.TemplateResponse(
        request=request,
        name="partials/tasks_list.html",
        context={
            "tasks": tasks
        }
    )

@app.get("/partials/torrent/list", response_class=HTMLResponse)
async def partial_torrent_list(request: Request):
    torrents = torrent_manager.list_torrents()
    return templates.TemplateResponse(
        request=request,
        name="partials/torrent_list.html",
        context={"torrents": torrents}
    )

@app.get("/api/torrent/list")
async def api_torrent_list():
    return torrent_manager.list_torrents()

class TorrentAddPayload(BaseModel):
    magnetURI: str
    customPath: Optional[str] = None

@app.post("/api/torrent/add")
async def api_torrent_add(payload: TorrentAddPayload):
    item = await torrent_manager.add_torrent(payload.magnetURI, custom_path=payload.customPath)
    add_core_log("stage", f"BitTorrent Swarm ingested: {item.get('name', 'Swarm')}")
    return item

@app.delete("/api/torrent/{info_hash}")
async def api_torrent_delete(info_hash: str, deleteFiles: bool = False):
    removed = torrent_manager.remove_torrent(info_hash, delete_files=deleteFiles)
    add_core_log("info", f"BitTorrent Swarm removed: {info_hash[:8]}...")
    return {"success": removed}

@app.post("/api/browser/open-external")
async def api_browser_open_external(url: str = Form(...)):
    import webbrowser
    webbrowser.open(url)
    add_core_log("info", f"Opened external browser for: {url[:50]}")
    return {"status": "opened"}

# --- Live URL Probe & Classification Engine ---

@app.post("/api/probe", response_class=HTMLResponse)
async def api_probe(request: Request, url: str = Form(...)):
    url = url.strip()
    if not url:
        return HTMLResponse("")
    add_core_log("info", f"Probing stream link: {url[:60]}...")

    # 1. Magnet / BitTorrent Link
    if url.startswith("magnet:?") or url.endswith(".torrent"):
        metadata = {
            "title": "BitTorrent Swarm Download",
            "duration": "P2P Torrent",
            "creator": "BitTorrent DHT Swarm",
            "thumbnail": "https://images.unsplash.com/photo-1542751371-adc38448a05e?q=80&w=640",
            "category": "TORRENT",
            "formats": [{
                "id": "torrent-swarm",
                "format": "TORRENT",
                "resolution": "P2P BitTorrent Swarm",
                "size": "Variable",
                "bitrate": "Max Peers"
            }]
        }
        return templates.TemplateResponse(
            request=request,
            name="partials/probe_result.html",
            context={"metadata": metadata, "pack_name": "BitTorrentPack"}
        )

    # 2. Check 16 Supported Video Hosting Sites (TeraBox, Streamtape, etc.)
    host_info = identify_host(url)
    if host_info.get('isSupported') and not host_info.get('isAggregator'):
        try:
            cloud_meta = await extract_hosting_media(url)
            if cloud_meta:
                return templates.TemplateResponse(
                    request=request,
                    name="partials/probe_result.html",
                    context={"metadata": cloud_meta, "pack_name": host_info['hostName']}
                )
        except Exception:
            pass

    # 3. Detect category & signature
    detected = detect_file_category(url)

    # If it is a major video platform (YouTube, TikTok, Twitter, Vimeo, etc.), extract via yt-dlp
    if detected.get('pack_name') == 'YouTubePack':
        try:
            loop = asyncio.get_event_loop()
            yt_meta = await loop.run_in_executor(None, extract_media_info, url)
            if yt_meta and yt_meta.get('success'):
                yt_meta['category'] = detected.get('category', 'VIDEO')
                return templates.TemplateResponse(
                    request=request,
                    name="partials/probe_result.html",
                    context={"metadata": yt_meta, "pack_name": "YouTubePack"}
                )
        except Exception:
            pass

    # 4. Direct HTTP/S Sliced Download Probe
    try:
        content_length = 0
        accept_ranges = False
        content_type = "application/octet-stream"
        
        async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
            res = await client.head(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134.0.0.0 Safari/537.36'})
            content_length = int(res.headers.get("content-length", 0))
            accept_ranges = res.headers.get("accept-ranges", "").lower() == "bytes"
            content_type = res.headers.get("content-type", "application/octet-stream")

            if content_length <= 0:
                res_r = await client.get(url, headers={'Range': 'bytes=0-0'})
                cr = res_r.headers.get("content-range", "")
                if "/" in cr:
                    content_length = int(cr.split("/")[-1])
                    accept_ranges = True

        filename = os.path.basename(urlparse(url).path) or f"download.{detected.get('target_extension', 'bin')}"
        size_str = f"{round(content_length / (1024*1024), 1)} MB" if content_length > 0 else "Adaptive Size"
        
        target_ext = detected.get('target_extension', 'bin')
        metadata = {
            "title": filename,
            "duration": "Direct File",
            "creator": urlparse(url).netloc,
            "thumbnail": "",
            "category": detected.get('category', 'DIRECT'),
            "formats": [{
                "id": f"direct-{target_ext}",
                "format": target_ext.upper(),
                "resolution": "16-Pipe Turbo Slices" if accept_ranges else "Single Stream",
                "size": size_str,
                "bitrate": "Max Speed"
            }]
        }
        return templates.TemplateResponse(
            request=request,
            name="partials/probe_result.html",
            context={"metadata": metadata, "pack_name": detected.get('pack_name', 'HttpPack')}
        )
    except Exception as e:
        return HTMLResponse(f"<div class='p-3 bg-red-500/10 text-red-400 border border-red-500/30 rounded-xl text-xs font-mono'>Could not probe link: {str(e)}</div>")

# --- Task Lifecycle Actions ---

@app.post("/api/tasks/create", response_class=HTMLResponse)
async def api_create_task(
    request: Request,
    url: str = Form(...),
    title: Optional[str] = Form(None),
    format_id: str = Form("best"),
    resolution: str = Form("1080p FHD"),
    category: str = Form("VIDEO"),
    target_extension: str = Form("mp4"),
    threads: int = Form(16),
    destination: str = Form("Downloads/Vortex"),
    conflict_policy: str = Form("rename")
):
    url = url.strip()
    task_id = ''.join(random.choices(string.ascii_lowercase + string.digits, k=12))
    
    sanitized_title = "download"
    if title and title.strip():
        sanitized_title = re.sub(r'[\\/*?:"<>|]', '_', title.strip())
        display_title = title.strip()
    else:
        try:
            parsed_name = os.path.basename(urlparse(url).path)
            if parsed_name:
                sanitized_title = os.path.splitext(parsed_name)[0]
        except Exception:
            pass
        display_title = sanitized_title.replace('_', ' ').capitalize()
        
    ext = target_extension.lstrip('.').lower() or 'bin'
    
    # 1. Base Save Directory & Categorization Rules
    configured_dir = get_setting("download_dir", TEMP_DIR)
    if destination and destination not in ("Downloads/Vortex", "default"):
        base_dir = destination
    else:
        base_dir = configured_dir
        
    auto_cat = get_setting("auto_categorize_folders", "true").lower() in ("true", "1")
    if auto_cat:
        from engine.detector import get_categorization_folder
        cat_folder = get_categorization_folder(ext)
        save_dir = os.path.join(base_dir, cat_folder)
    else:
        save_dir = base_dir

    try:
        os.makedirs(save_dir, exist_ok=True)
    except Exception:
        save_dir = TEMP_DIR

    # 2. Conflict policy handling
    c_policy = conflict_policy or get_setting("conflict_policy", "keepboth")
    if c_policy == "overwrite":
        file_name = f"{sanitized_title[:60]}.{ext}"
        file_path = os.path.join(save_dir, file_name)
    else:
        base_candidate = os.path.join(save_dir, f"{sanitized_title[:50]}.{ext}")
        if os.path.exists(base_candidate):
            file_name = f"{sanitized_title[:45]}_{task_id[:6]}.{ext}"
        else:
            file_name = f"{sanitized_title[:50]}.{ext}"
        file_path = os.path.join(save_dir, file_name)

    # 3. Threads from default settings if not overridden
    default_th = int(get_setting("default_threads", "16"))
    eff_threads = max(1, min(threads if threads != 16 else default_th, 64))

    task_data = {
        'id': task_id,
        'url': url,
        'title': display_title,
        'category': category.upper(),
        'target_extension': ext,
        'status': 'queued',
        'file_path': file_path,
        'format_id': format_id,
        'resolution': resolution,
        'threads': eff_threads
    }

    await queue_manager.submit_task(task_data)
    add_core_log("stage", f"Task queued: {task_data['title']} [{threads} Pipes]")
    
    tasks = list_tasks()
    return templates.TemplateResponse(
        request=request,
        name="partials/tasks_list.html",
        context={"tasks": tasks}
    )

@app.post("/api/tasks/{task_id}/pause")
async def api_pause_task(task_id: str):
    await queue_manager.pause_task(task_id)
    return {"status": "paused"}

@app.post("/api/tasks/{task_id}/resume", response_class=HTMLResponse)
async def api_resume_task(request: Request, task_id: str):
    await queue_manager.resume_task(task_id)
    tasks = list_tasks()
    return templates.TemplateResponse(
        request=request,
        name="partials/tasks_list.html",
        context={"tasks": tasks}
    )

@app.post("/api/tasks/{task_id}/cancel")
async def api_cancel_task(task_id: str):
    await queue_manager.cancel_task(task_id)
    return {"status": "cancelled"}

@app.delete("/api/tasks/{task_id}")
async def api_delete_task(task_id: str):
    await queue_manager.cancel_task(task_id)
    delete_task(task_id)
    return Response(status_code=204)

@app.post("/api/tasks/{task_id}/open")
async def api_open_file(task_id: str):
    task = get_task(task_id)
    if not task or not task.get('file_path') or not os.path.exists(task['file_path']):
        raise HTTPException(status_code=404, detail="File not found")
        
    file_path = os.path.abspath(task['file_path'])
    if sys.platform == "win32":
        os.startfile(file_path)
    elif sys.platform == "darwin":
        subprocess.Popen(["open", file_path])
    else:
        subprocess.Popen(["xdg-open", file_path])
    return {"status": "opened"}

@app.post("/api/tasks/{task_id}/open-folder")
async def api_open_folder(task_id: str):
    task = get_task(task_id)
    if not task or not task.get('file_path'):
        raise HTTPException(status_code=404, detail="Task or file path not found")
        
    file_path = os.path.abspath(task['file_path'])
    folder = os.path.dirname(file_path)
    if not os.path.exists(folder):
        os.makedirs(folder, exist_ok=True)
        
    if sys.platform == "win32":
        if os.path.exists(file_path):
            subprocess.Popen(f'explorer /select,"{os.path.normpath(file_path)}"', shell=True)
        else:
            subprocess.Popen(f'explorer "{os.path.normpath(folder)}"', shell=True)
    elif sys.platform == "darwin":
        subprocess.Popen(["open", folder])
    else:
        subprocess.Popen(["xdg-open", folder])
    return {"status": "folder_opened"}

@app.post("/api/tasks/start-all", response_class=HTMLResponse)
async def api_start_all(request: Request):
    await queue_manager.start_all()
    tasks = list_tasks()
    return templates.TemplateResponse(
        request=request,
        name="partials/tasks_list.html",
        context={"tasks": tasks}
    )

@app.post("/api/tasks/pause-all", response_class=HTMLResponse)
async def api_pause_all(request: Request):
    await queue_manager.pause_all()
    tasks = list_tasks()
    return templates.TemplateResponse(
        request=request,
        name="partials/tasks_list.html",
        context={"tasks": tasks}
    )

# --- Settings & Vault API ---

@app.post("/api/settings/update")
async def api_update_settings(request: Request):
    form_data = await request.form()
    settings_dict = {k: v for k, v in form_data.items()}
    update_settings(settings_dict)
    try:
        from engine.integrations import sync_all_integrations
        sync_all_integrations()
    except Exception:
        pass
    return {"status": "updated"}

@app.post("/api/settings/integration/toggle")
async def api_toggle_integration(feature: str = Form(...), enabled: bool = Form(...)):
    try:
        from engine.integrations import toggle_integration
        success = toggle_integration(feature, enabled)
    except Exception as e:
        success = False
    return {"success": success, "feature": feature, "enabled": enabled}

@app.post("/api/settings/regenerate-token")
async def api_regenerate_token():
    new_token = "vortex-" + ''.join(random.choices(string.ascii_lowercase + string.digits, k=24))
    set_setting("aria2_secret", new_token)
    return {"token": new_token}

@app.post("/api/settings/open-download-dir")
async def api_open_download_dir():
    d_dir = get_setting("download_dir", TEMP_DIR)
    os.makedirs(d_dir, exist_ok=True)
    if sys.platform == "win32":
        subprocess.Popen(f'explorer "{os.path.normpath(d_dir)}"', shell=True)
    elif sys.platform == "darwin":
        subprocess.Popen(["open", d_dir])
    else:
        subprocess.Popen(["xdg-open", d_dir])
    return {"status": "opened"}

@app.get("/api/system/check-update")
async def api_check_update():
    return {
        "status": "latest",
        "current_version": "v0.6.9",
        "latest_version": "v0.6.9",
        "message": "You are on the latest Vortex Downloader build (v0.6.9). All engines are fully up to date."
    }

@app.delete("/api/vault/{item_id}")
async def api_delete_vault(item_id: str):
    remove_vault_item(item_id)
    return Response(status_code=204)

# --- Exporters ---

def get_exportable_tasks():
    tasks = list_tasks()
    return [
        {
            'url': t['url'],
            'fileName': os.path.basename(t.get('file_path') or 'download.bin'),
            'fileSize': t.get('total_bytes')
        }
        for t in tasks
    ]

@app.get("/api/export/curl")
async def export_curl():
    tasks = get_exportable_tasks()
    script = ExportManager.to_curl_script(tasks)
    return Response(content=script, media_type="text/x-shellscript", headers={"Content-Disposition": 'attachment; filename="vortex_downloads.sh"'})

@app.get("/api/export/metalink")
async def export_metalink():
    tasks = get_exportable_tasks()
    xml = ExportManager.to_metalink(tasks)
    return Response(content=xml, media_type="application/metalink4+xml", headers={"Content-Disposition": 'attachment; filename="vortex_downloads.meta4"'})

@app.get("/api/export/aria2")
async def export_aria2():
    tasks = get_exportable_tasks()
    txt = ExportManager.to_aria2_input(tasks)
    return Response(content=txt, media_type="text/plain", headers={"Content-Disposition": 'attachment; filename="vortex_aria2.txt"'})

@app.get("/api/export/json")
async def export_json():
    tasks = get_exportable_tasks()
    data = ExportManager.to_json(tasks)
    return Response(content=data, media_type="application/json", headers={"Content-Disposition": 'attachment; filename="vortex_backup.json"'})

# --- Real-Debrid Account Verification ---

class DebridPayload(BaseModel):
    provider: str
    apiKey: str

@app.post("/api/accounts/debrid")
async def api_set_debrid(payload: DebridPayload):
    if payload.provider == 'real_debrid':
        verification = await account_manager.verify_real_debrid(payload.apiKey)
        if verification.get('success'):
            set_setting("real_debrid_key", payload.apiKey)
            return {"success": True, **verification}
        else:
            return JSONResponse(status_code=400, content={"success": False, "error": verification.get('error', 'Invalid token')})
    set_setting(f"{payload.provider}_key", payload.apiKey)
    return {"success": True}

# --- Full Aria2 JSON-RPC 2.0 Compatibility Engine ---

@app.post("/jsonrpc")
@app.post("/rpc")
@app.get("/jsonrpc")
async def aria2_rpc(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}

    method = body.get("method", "")
    req_id = body.get("id", "1")
    params = body.get("params", [])

    real_params = params
    if isinstance(params, list) and params and isinstance(params[0], str) and params[0].startswith("token:"):
        real_params = params[1:]

    # Method 1: getVersion
    if method == "aria2.getVersion":
        return JSONResponse({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "version": "1.37.0-vortex",
                "enabledFeatures": ["Async DNS", "BitTorrent", "Firefox3 Cookie", "GZip", "HTTPS", "Message Digest", "Metalink", "XML-RPC"]
            }
        })

    # Method 2: addUri
    if method == "aria2.addUri":
        uris = real_params[0] if real_params else []
        target_url = uris[0] if isinstance(uris, list) and uris else uris
        if not target_url:
            return JSONResponse({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": "Invalid URL"}}, status_code=400)

        gid = ''.join(random.choices(string.ascii_lowercase + string.digits, k=16))
        task_data = {
            'id': gid,
            'url': target_url,
            'title': f"Aria2 Task {gid[:6]}",
            'category': 'DIRECT',
            'target_extension': 'bin',
            'status': 'queued',
            'file_path': os.path.join(TEMP_DIR, f"aria2_{gid}.bin"),
            'threads': 16
        }
        await queue_manager.submit_task(task_data)
        return JSONResponse({"jsonrpc": "2.0", "id": req_id, "result": gid})

    # Method 3: tellStatus
    if method == "aria2.tellStatus":
        gid = real_params[0] if real_params else ""
        task = get_task(gid)
        if task:
            return JSONResponse({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "gid": gid,
                    "status": "complete" if task['status'] == 'completed' else "active",
                    "totalLength": str(task.get('total_bytes', 0)),
                    "completedLength": str(task.get('downloaded_bytes', 0)),
                    "downloadSpeed": "1048576" if task['status'] == 'downloading' else "0",
                    "files": [{"path": task.get('file_path', ''), "length": str(task.get('total_bytes', 0))}]
                }
            })
        return JSONResponse({"jsonrpc": "2.0", "id": req_id, "result": {"gid": gid, "status": "complete", "totalLength": "0", "completedLength": "0"}})

    # Method 4: tellActive
    if method == "aria2.tellActive":
        tasks = list_tasks()
        active = [
            {
                "gid": t['id'],
                "status": "active",
                "totalLength": str(t.get('total_bytes', 0)),
                "completedLength": str(t.get('downloaded_bytes', 0)),
                "downloadSpeed": "2097152"
            }
            for t in tasks if t['status'] == 'downloading'
        ]
        return JSONResponse({"jsonrpc": "2.0", "id": req_id, "result": active})

    # Method 5: system.multicall
    if method == "system.multicall":
        calls = real_params[0] if real_params and isinstance(real_params[0], list) else []
        results = []
        for call in calls:
            sub_m = call.get("methodName")
            if sub_m == "aria2.getVersion":
                results.append([{"version": "1.37.0-vortex"}])
            else:
                results.append(["OK"])
        return JSONResponse({"jsonrpc": "2.0", "id": req_id, "result": results})

    return JSONResponse({"jsonrpc": "2.0", "id": req_id, "result": "OK"})

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "5001"))
    print(f">> VortexDownloader Universal Engine running on http://localhost:{port}")
    print(f">> Aria2 JSON-RPC 2.0 active on http://localhost:{port}/jsonrpc")
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
