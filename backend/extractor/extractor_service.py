import os
import sys
import json
import re
import time
import subprocess
import threading
import random
import string
import asyncio
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs

# Hook static-ffmpeg if available
try:
    import static_ffmpeg
    static_ffmpeg.add_paths()
except ImportError:
    pass

import httpx
import yt_dlp

# Register backend root in sys.path
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from feature_packs.github_pack import GitHubPack
from feature_packs.huggingface_pack import HuggingFacePack
from feature_packs.ed2k_pack import Ed2kPack
from feature_packs.m3u8_pack import M3u8Pack
from feature_packs.ftp_pack import FtpPack
from accounts.account_manager import account_manager
from exporters.export_manager import ExportManager
from plugins.plugin_manager import plugin_manager

github_pack = GitHubPack()
huggingface_pack = HuggingFacePack()
ed2k_pack = Ed2kPack()
m3u8_pack = M3u8Pack()
ftp_pack = FtpPack()
export_manager = ExportManager()

ftp_jobs = {}

def format_duration(seconds):
    if not seconds:
        return "00:00"
    try:
        seconds = int(seconds)
        h = seconds // 3600
        m = (seconds % 3600) // 60
        s = seconds % 60
        return f"{h:02d}:{m:02d}:{s:02d}" if h > 0 else f"{m:02d}:{s:02d}"
    except Exception:
        return "00:00"

def format_size(bytes_num):
    if not bytes_num:
        return "Adaptive Size"
    try:
        bytes_num = float(bytes_num)
        for unit in ['B', 'KB', 'MB', 'GB']:
            if bytes_num < 1024.0:
                return f"{bytes_num:.1f} {unit}"
            bytes_num /= 1024.0
        return f"{bytes_num:.1f} TB"
    except Exception:
        return "Adaptive Size"

def format_speed(bps):
    if not bps or bps <= 0:
        return "0.0 MB/s"
    for unit in ['B/s', 'KB/s', 'MB/s', 'GB/s']:
        if bps < 1024.0:
            return f"{bps:.1f} {unit}"
        bps /= 1024.0
    return f"{bps:.1f} TB/s"

def format_eta(seconds):
    if not seconds or seconds <= 0 or seconds > 86400:
        return "--"
    if seconds < 60:
        return f"{int(seconds)}s"
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f"{m}m {s}s"

def get_base_opts():
    opts = {
        'quiet': True,
        'no_warnings': True,
        'noplaylist': True,
        # Remote components to pull up-to-date JS player decryptors
        'remote_components': {'ejs:github'},
        # Enable Node.js for YouTube nsig signature deciphering (enables 720p, 1080p, 2K, 4K)
        'js_runtimes': {'node': {}},
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Sec-CH-UA': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
            'Sec-CH-UA-Mobile': '?0',
            'Sec-CH-UA-Platform': '"Windows"',
        }
    }

    base_dir = os.path.dirname(os.path.abspath(__file__))
    parent_dir = os.path.dirname(base_dir)
    cookie_paths = [
        os.getenv('YTDLP_COOKIES_PATH', ''),
        os.path.join(base_dir, 'cookies.txt'),
        os.path.join(parent_dir, 'cookies.txt')
    ]
    for cp in cookie_paths:
        if cp and os.path.isfile(cp):
            opts['cookiefile'] = cp
            break

    browser = os.getenv('YTDLP_COOKIES_BROWSER')
    if browser:
        opts['cookiesfrombrowser'] = (browser,)

    raw_cookie = os.getenv('YTDLP_RAW_COOKIE')
    if raw_cookie:
        opts['http_headers']['Cookie'] = raw_cookie

    return opts

def extract_with_bot_evasion(ydl_opts, url):
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            return ydl.extract_info(url, download=False)
    except Exception as e:
        err = str(e).lower()
        if any(term in err for term in ['bot', 'sign in', '429', 'login', 'confirm', 'captcha', '403']):
            # 1. Automatically inherit session cookies from installed browsers
            for browser in ['edge', 'chrome', 'firefox', 'brave', 'opera']:
                try:
                    fallback_opts = dict(ydl_opts)
                    fallback_opts['cookiesfrombrowser'] = (browser,)
                    with yt_dlp.YoutubeDL(fallback_opts) as ydl:
                        info = ydl.extract_info(url, download=False)
                        if info:
                            return info
                except Exception:
                    continue

            # 2. Try YouTube client rotation
            if 'youtube' in url.lower() or 'youtu.be' in url.lower():
                for alt_client in [['web_safari'], ['mweb', 'web'], ['tv']]:
                    try:
                        fallback_opts = dict(ydl_opts)
                        fallback_opts['extractor_args'] = {'youtube': {'player_client': alt_client}}
                        with yt_dlp.YoutubeDL(fallback_opts) as ydl:
                            info = ydl.extract_info(url, download=False)
                            if info:
                                return info
                    except Exception:
                        continue
        raise e

def perform_extraction(url):
    ydl_opts = {
        'skip_download': True,
        'extract_flat': False,
        **get_base_opts()
    }

    info = extract_with_bot_evasion(ydl_opts, url)
    if not info:
        raise Exception("No metadata returned by yt-dlp")

    # If search result or playlist entry
    if 'entries' in info and info['entries']:
        info = info['entries'][0]

    title = info.get('title') or 'Extracted Media'
    duration = format_duration(info.get('duration'))
    creator = info.get('uploader') or info.get('channel') or info.get('creator') or 'Web Stream'

    thumbnails = info.get('thumbnails', [])
    thumbnail = thumbnails[-1].get('url', '') if thumbnails else info.get('thumbnail', '')

    formats_list = info.get('formats', [])
    parsed_formats = []

    # Filter video formats with height
    video_formats = [f for f in formats_list if f.get('height') and f.get('vcodec') != 'none']

    # Sort descending by height, favoring h264/avc codecs for universal compatibility
    def sort_key(f):
        h = f.get('height') or 0
        vcodec = (f.get('vcodec') or '').lower()
        is_h264 = 1 if (vcodec.startswith(('avc1', 'h264', 'mp4v')) or 'h264' in vcodec) else 0
        tbr = f.get('tbr') or 0
        return (h, is_h264, tbr)

    video_formats.sort(key=sort_key, reverse=True)
    seen_buckets = set()

    for f in video_formats:
        height = f.get('height')
        if not height:
            continue

        if height >= 2160:
            res_label = "4K UHD (2160p)"
            res_bucket = 2160
        elif height >= 1440:
            res_label = "2K QHD (1440p)"
            res_bucket = 1440
        elif height >= 1080:
            res_label = "1080p FHD"
            res_bucket = 1080
        elif height >= 720:
            res_label = "720p HD"
            res_bucket = 720
        elif height >= 480:
            res_label = "480p SD"
            res_bucket = 480
        elif height >= 360:
            res_label = "360p"
            res_bucket = 360
        elif height >= 240:
            res_label = "240p"
            res_bucket = 240
        else:
            res_label = f"{height}p"
            res_bucket = height

        if res_bucket in seen_buckets:
            continue
        seen_buckets.add(res_bucket)

        vsize = f.get('filesize') or f.get('filesize_approx')
        asize = 128 * 1024 * (info.get('duration', 0) or 0) / 8
        total_size = (vsize + asize) if vsize else None

        parsed_formats.append({
            "id": str(f.get('format_id')),
            "format": "MP4",
            "resolution": res_label,
            "size": format_size(total_size),
            "bitrate": f"{int(f.get('tbr', 0))} kbps" if f.get('tbr') else "Variable",
            "directUrl": f.get('url', ''),
            "targetExtension": "mp4"
        })

    if not parsed_formats:
        parsed_formats.append({
            "id": "best",
            "format": "MP4",
            "resolution": "Best Video Stream",
            "size": "Adaptive Stream",
            "bitrate": "Variable",
            "directUrl": info.get('url', ''),
            "targetExtension": "mp4"
        })

    parsed_formats.append({
        "id": "bestaudio",
        "format": "MP3",
        "resolution": "Audio 320kbps (MP3)",
        "size": format_size(320 * 1024 * (info.get('duration', 0) or 0) / 8) if info.get('duration') else "Adaptive Size",
        "bitrate": "320 kbps",
        "targetExtension": "mp3"
    })
    parsed_formats.append({
        "id": "bestaudio-m4a",
        "format": "M4A",
        "resolution": "Audio 192kbps (AAC/M4A)",
        "size": format_size(192 * 1024 * (info.get('duration', 0) or 0) / 8) if info.get('duration') else "Adaptive Size",
        "bitrate": "192 kbps",
        "targetExtension": "m4a"
    })

    return {
        "title": title,
        "duration": duration,
        "creator": creator,
        "thumbnail": thumbnail,
        "originalUrl": url,
        "formats": parsed_formats,
        "isLive": info.get('is_live', False)
    }

# In-memory progress tracker
live_jobs = {}

def perform_download_stream(job_id, url, format_id, output_path, progress_cb=None):
    output_path = os.path.abspath(output_path)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    base_dir = os.path.dirname(output_path)
    file_name_no_ext = os.path.basename(output_path)
    outtmpl = os.path.join(base_dir, file_name_no_ext.split('.')[0] + '.%(ext)s')

    is_audio = any(a in format_id.lower() for a in ['audio', 'mp3', 'm4a', 'aac']) or output_path.lower().endswith(('.mp3', '.m4a'))

    last_update_time = [0.0]

    def download_hook(d):
        if d['status'] == 'downloading':
            total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
            downloaded = d.get('downloaded_bytes') or 0
            speed = d.get('speed') or 0
            eta = d.get('eta') or 0

            raw_percent = 0.0
            if total > 0:
                raw_percent = (downloaded / total) * 100.0

            # Multi-stream scaling: video 0-88%, audio 88-98%, muxing 99%
            info = d.get('info_dict') or {}
            vcodec = info.get('vcodec')
            acodec = info.get('acodec')
            if vcodec and vcodec != 'none' and acodec == 'none':
                effective_percent = min(88.0, raw_percent * 0.88)
            elif acodec and acodec != 'none' and (not vcodec or vcodec == 'none'):
                effective_percent = min(98.0, 88.0 + (raw_percent * 0.10))
            else:
                effective_percent = min(98.0, raw_percent)

            now = time.time()
            if now - last_update_time[0] >= 0.18:
                last_update_time[0] = now
                p_data = {
                    'percent': int(effective_percent),
                    'downloadedBytes': downloaded,
                    'totalBytes': total,
                    'speed': format_speed(speed),
                    'speedBytesPerSec': speed,
                    'eta': format_eta(eta),
                    'status': 'downloading'
                }
                live_jobs[job_id] = p_data
                if progress_cb:
                    progress_cb(p_data)
        elif d['status'] == 'finished':
            p_data = {
                'percent': 99,
                'status': 'downloading',
                'speed': 'Muxing Streams...',
                'eta': '0s'
            }
            live_jobs[job_id] = p_data
            if progress_cb:
                progress_cb(p_data)

    ydl_opts = {
        'outtmpl': outtmpl,
        'progress_hooks': [download_hook],
        'concurrent_fragment_downloads': 16,
        'buffersize': 1024 * 1024 * 8,
        'retries': 10,
        'fragment_retries': 10,
        **get_base_opts()
    }

    if is_audio:
        codec = 'm4a' if ('m4a' in format_id.lower() or 'aac' in format_id.lower() or output_path.lower().endswith('.m4a')) else 'mp3'
        ydl_opts.update({
            'format': 'bestaudio/best',
            'postprocessors': [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': codec,
                'preferredquality': '320',
            }]
        })
    else:
        res_match = re.search(r'(\d{3,4})', format_id)
        if res_match and int(res_match.group(1)) in [2160, 1440, 1080, 720, 480, 360, 240]:
            h = int(res_match.group(1))
            format_selector = (
                f"bestvideo[height<={h}][vcodec^=avc1]+bestaudio[ext=m4a]/"
                f"bestvideo[height<={h}]+bestaudio/"
                f"best[height<={h}]/best"
            )
        elif format_id.isdigit():
            format_selector = f"{format_id}+bestaudio/best"
        else:
            format_selector = "bestvideo+bestaudio/best"

        ydl_opts['format'] = format_selector
        ydl_opts['merge_output_format'] = 'mp4'
        ydl_opts['postprocessor_args'] = {
            'merger': ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
            'ffmpeg': ['-movflags', '+faststart']
        }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
    except Exception as e:
        err = str(e).lower()
        if any(term in err for term in ['bot', 'sign in', '429', 'login', 'confirm', 'captcha', '403']):
            downloaded_ok = False
            for browser in ['edge', 'chrome', 'firefox', 'brave', 'opera']:
                try:
                    fallback_opts = dict(ydl_opts)
                    fallback_opts['cookiesfrombrowser'] = (browser,)
                    with yt_dlp.YoutubeDL(fallback_opts) as ydl:
                        ydl.download([url])
                    downloaded_ok = True
                    break
                except Exception:
                    continue
            if not downloaded_ok:
                raise e
        else:
            raise e

    final_path = output_path
    if not os.path.exists(output_path):
        base_name_no_ext = file_name_no_ext.split('.')[0]
        for f in os.listdir(base_dir):
            if f.startswith(base_name_no_ext):
                actual_path = os.path.join(base_dir, f)
                if actual_path != output_path:
                    if os.path.exists(output_path):
                        os.remove(output_path)
                    os.rename(actual_path, output_path)
                final_path = output_path
                break

    comp_data = {
        'percent': 100,
        'status': 'completed',
        'speed': '0.0 MB/s',
        'eta': '0s',
        'filePath': final_path
    }
    live_jobs[job_id] = comp_data
    if progress_cb:
        progress_cb(comp_data)

    return final_path

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

class ExtractorHandler(BaseHTTPRequestHandler):
    def send_json(self, status, data):
        body = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, status, text, content_type="text/plain; charset=utf-8"):
        body = text.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, file_path, filename):
        if not os.path.isfile(file_path):
            self.send_json(404, {"error": "File not found"})
            return
        size = os.path.getsize(file_path)
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
        self.send_header('Content-Length', str(size))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        with open(file_path, 'rb') as f:
            while chunk := f.read(64 * 1024):
                self.wfile.write(chunk)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        if parsed.path == '/health' or parsed.path == '/api/health':
            self.send_json(200, {"status": "ok", "service": "Vortex Python Extractor Sidecar v1.0.0"})
            return

        elif parsed.path == '/download-progress':
            job_id = qs.get('jobId', [''])[0]
            job = live_jobs.get(job_id)
            if job:
                self.send_json(200, job)
            else:
                self.send_json(404, {"error": "Job not found"})
            return

        elif parsed.path == '/api/github/accelerate':
            target_url = qs.get('url', [''])[0]
            if not target_url:
                self.send_json(400, {"detail": "url query parameter required"})
                return
            self.send_json(200, {"mirrors": github_pack.get_accelerated_urls(target_url)})
            return

        elif parsed.path == '/api/ftp/progress':
            job_id = qs.get('jobId', [''])[0]
            job = ftp_jobs.get(job_id)
            if not job:
                self.send_json(404, {"detail": "FTP job not found."})
                return
            self.send_json(200, {
                'jobId': job['id'],
                'fileName': job['fileName'],
                'status': job['status'],
                'error': job.get('error'),
                **job['progress']
            })
            return

        elif parsed.path == '/api/ftp/file':
            job_id = qs.get('jobId', [''])[0]
            job = ftp_jobs.get(job_id)
            if not job or job.get('status') != 'completed' or not os.path.isfile(job.get('filePath', '')):
                self.send_json(400, {"detail": "File is not ready or downloading."})
                return
            self.send_file(job['filePath'], job['fileName'])
            return

        elif parsed.path == '/api/plugins':
            self.send_json(200, plugin_manager.list_plugins())
            return

        elif parsed.path == '/api/accounts/list':
            self.send_json(200, {"accounts": account_manager.list_accounts()})
            return

        elif parsed.path == '/api/export/curl':
            target_url = qs.get('url', [''])[0]
            fn = qs.get('filename', ['download.bin'])[0]
            tasks = [{'url': target_url, 'fileName': fn}] if target_url else []
            self.send_text(200, ExportManager.to_curl_script(tasks))
            return

        elif parsed.path == '/api/export/metalink':
            target_url = qs.get('url', [''])[0]
            fn = qs.get('filename', ['download.bin'])[0]
            tasks = [{'url': target_url, 'fileName': fn}] if target_url else []
            self.send_text(200, ExportManager.to_metalink(tasks), content_type="application/metalink4+xml")
            return

        elif parsed.path == '/api/export/aria2':
            target_url = qs.get('url', [''])[0]
            fn = qs.get('filename', ['download.bin'])[0]
            tasks = [{'url': target_url, 'fileName': fn}] if target_url else []
            self.send_text(200, ExportManager.to_aria2_input(tasks))
            return

        elif parsed.path == '/api/export/json':
            self.send_text(200, ExportManager.to_json([]), content_type="application/json")
            return

        self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length) if content_length > 0 else b'{}'

        try:
            req_data = json.loads(body.decode('utf-8')) if body else {}
        except Exception:
            self.send_json(400, {"detail": "Invalid JSON body"})
            return

        if parsed.path == '/extract':
            target_url = req_data.get('url', '').strip()
            if not target_url:
                self.send_json(400, {"detail": "URL parameter required"})
                return

            try:
                result = perform_extraction(target_url)
                self.send_json(200, result)
            except Exception as e:
                self.send_json(400, {"detail": str(e)})

        elif parsed.path == '/download-stream':
            job_id = req_data.get('jobId', 'stream_' + str(int(time.time())))
            target_url = req_data.get('url', '').strip()
            format_id = req_data.get('formatId', 'best').strip()
            output_path = req_data.get('outputPath', '').strip()

            if not target_url or not output_path:
                self.send_json(400, {"detail": "URL and outputPath are required"})
                return

            # Set streaming chunked response headers so Go reads progress in real time
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson')
            self.send_header('Transfer-Encoding', 'chunked')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()

            def stream_chunk(chunk_dict):
                try:
                    payload = json.dumps(chunk_dict) + "\n"
                    raw = payload.encode('utf-8')
                    # HTTP Chunked encoding: <hex length>\r\n<data>\r\n
                    chunk_header = f"{len(raw):X}\r\n".encode('ascii')
                    self.wfile.write(chunk_header + raw + b"\r\n")
                    self.wfile.flush()
                except Exception:
                    pass

            try:
                final_path = perform_download_stream(job_id, target_url, format_id, output_path, progress_cb=stream_chunk)
                stream_chunk({"status": "completed", "percent": 100, "speed": "0.0 MB/s", "eta": "0s", "filePath": final_path})
            except Exception as e:
                stream_chunk({"status": "error", "error": str(e)})

            # End chunked stream: 0\r\n\r\n
            try:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except Exception:
                pass

        elif parsed.path == '/api/github/inspect':
            target_url = req_data.get('url', '').strip()
            parsed_gh = github_pack.parse_url(target_url)
            if not parsed_gh.get('isGitHub'):
                self.send_json(400, {"detail": "Not a recognized GitHub repository or release URL."})
                return

            ptype = parsed_gh.get('type')
            if ptype in ('raw', 'release-direct', 'archive'):
                self.send_json(200, {
                    'type': 'direct',
                    'directUrl': parsed_gh.get('directUrl'),
                    'owner': parsed_gh.get('owner'),
                    'repo': parsed_gh.get('repo')
                })
                return

            try:
                release = asyncio.run(github_pack.inspect_release(parsed_gh.get('owner', ''), parsed_gh.get('repo', ''), parsed_gh.get('tag')))
                self.send_json(200, {
                    'type': 'release',
                    'owner': parsed_gh.get('owner'),
                    'repo': parsed_gh.get('repo'),
                    'release': release
                })
            except Exception as e:
                self.send_json(500, {"detail": str(e)})

        elif parsed.path == '/api/huggingface/inspect':
            target_url = req_data.get('url', '').strip()
            parsed_hf = huggingface_pack.parse_url(target_url)
            if not parsed_hf.get('isHuggingFace'):
                self.send_json(400, {"detail": "Not a recognized Hugging Face model or dataset URL."})
                return

            if parsed_hf.get('isDirectFile') and parsed_hf.get('directUrl'):
                self.send_json(200, {
                    'type': 'direct',
                    'directUrl': parsed_hf.get('directUrl'),
                    'modelId': parsed_hf.get('modelId'),
                    'filePath': parsed_hf.get('filePath')
                })
                return

            try:
                model_info = asyncio.run(huggingface_pack.inspect_model(
                    parsed_hf.get('modelId', ''),
                    parsed_hf.get('revision', 'main'),
                    parsed_hf.get('repoType', 'model')
                ))
                self.send_json(200, {
                    'type': 'model',
                    'modelInfo': model_info
                })
            except Exception as e:
                self.send_json(500, {"detail": str(e)})

        elif parsed.path == '/api/ed2k/inspect':
            target_url = req_data.get('url', '').strip()
            info = ed2k_pack.parse_url(target_url)
            if not info.get('isValid'):
                self.send_json(400, {"detail": info.get('error', 'Invalid eD2k URI.')})
                return
            self.send_json(200, {'type': 'ed2k', 'info': info})

        elif parsed.path == '/api/m3u8/inspect':
            target_url = req_data.get('url', '').strip()
            if not m3u8_pack.is_m3u8(target_url):
                self.send_json(400, {"detail": "URL does not appear to be an HLS/m3u8 stream."})
                return

            try:
                with httpx.Client(timeout=10.0, follow_redirects=True) as client:
                    res = client.get(target_url, headers={'User-Agent': 'Mozilla/5.0'})
                    if res.status_code != 200:
                        self.send_json(400, {"detail": f"Failed to fetch m3u8 playlist: HTTP {res.status_code}"})
                        return
                    content = res.text
                manifest = m3u8_pack.parse_manifest(content, target_url)
                self.send_json(200, manifest)
            except Exception as e:
                self.send_json(500, {"detail": str(e)})

        elif parsed.path == '/api/ftp/download':
            target_url = req_data.get('url', '').strip()
            try:
                info = ftp_pack.parse_url(target_url)
            except Exception as e:
                self.send_json(400, {"detail": f"Invalid FTP URL: {e}"})
                return

            job_id = 'ftp_' + ''.join(random.choices(string.ascii_lowercase + string.digits, k=10))
            ftp_jobs[job_id] = {
                'id': job_id,
                'url': target_url,
                'fileName': info['fileName'],
                'filePath': None,
                'status': 'downloading',
                'progress': {
                    'bytesDownloaded': 0,
                    'totalBytes': 0,
                    'percent': 0,
                    'speed': '0.0 MB/s',
                    'eta': '--'
                }
            }

            def run_ftp_task():
                pack = FtpPack()
                def on_p(p):
                    if job_id in ftp_jobs:
                        ftp_jobs[job_id]['progress'] = p
                try:
                    temp_dir = os.path.join(BASE_DIR, 'temp_downloads')
                    res = pack.download_file(target_url, temp_dir, on_progress=on_p)
                    if job_id in ftp_jobs:
                        ftp_jobs[job_id]['status'] = 'completed'
                        ftp_jobs[job_id]['filePath'] = res['filePath']
                except Exception as e:
                    if job_id in ftp_jobs:
                        ftp_jobs[job_id]['status'] = 'error'
                        ftp_jobs[job_id]['error'] = str(e)

            t = threading.Thread(target=run_ftp_task, daemon=True)
            t.start()
            self.send_json(200, {'jobId': job_id, 'fileName': info['fileName'], 'status': 'downloading'})

        elif parsed.path == '/api/plugins/resolve':
            target_url = req_data.get('url', '').strip()
            try:
                loop = asyncio.new_event_loop()
                res = loop.run_until_complete(plugin_manager.resolve(target_url))
                loop.close()
                self.send_json(200, res)
            except Exception as e:
                self.send_json(500, {"detail": str(e)})

        elif parsed.path == '/api/accounts/debrid':
            provider = req_data.get('provider', '').strip()
            api_key = req_data.get('apiKey', '').strip()
            if provider == 'real_debrid':
                try:
                    loop = asyncio.new_event_loop()
                    verification = loop.run_until_complete(account_manager.verify_real_debrid(api_key))
                    loop.close()
                    if not verification.get('success'):
                        self.send_json(400, {"detail": verification.get('error', 'Verification failed')})
                        return
                    self.send_json(200, {"success": True, **verification})
                    return
                except Exception as e:
                    self.send_json(500, {"detail": str(e)})
                    return

            account_manager.set_account({
                'provider': provider,
                'apiKey': api_key,
                'status': 'active'
            })
            self.send_json(200, {"success": True, "provider": provider})

        else:
            self.send_json(404, {"detail": "Endpoint not found"})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith('/api/accounts/debrid/'):
            provider = parsed.path.split('/')[-1]
            account_manager.remove_account(provider)
            self.send_json(200, {"success": True, "removed": provider})
            return
        self.send_json(404, {"detail": "Endpoint not found"})

    def log_message(self, format, *args):
        pass

def run():
    port = int(os.getenv("PORT", "5002"))
    server = ThreadedHTTPServer(('127.0.0.1', port), ExtractorHandler)
    print(f">> Starting Vortex Python Extractor Sidecar on 127.0.0.1:{port}...", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == "__main__":
    run()
