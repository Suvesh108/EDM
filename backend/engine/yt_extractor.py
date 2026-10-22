import os
import sys
import json
import re
import time
import subprocess
from typing import Dict, Any, Optional, Callable, List

import shutil

# Hook static-ffmpeg path if system ffmpeg is not already available
if not shutil.which('ffmpeg'):
    try:
        import static_ffmpeg
        static_ffmpeg.add_paths()
    except Exception:
        pass

import yt_dlp
import httpx

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

def format_speed(speed_bytes):
    if not speed_bytes:
        return "0.0 B/s"
    try:
        speed_bytes = float(speed_bytes)
        for unit in ['B/s', 'KB/s', 'MB/s', 'GB/s']:
            if speed_bytes < 1024.0:
                return f"{speed_bytes:.1f} {unit}"
            speed_bytes /= 1024.0
        return f"{speed_bytes:.1f} TB/s"
    except Exception:
        return "0.0 B/s"

def get_base_ydl_opts() -> Dict[str, Any]:
    opts = {
        'quiet': True,
        'no_warnings': True,
        'noplaylist': True,
        'remote_components': {'ejs:github'},
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
    cookie_file = os.getenv('YTDLP_COOKIES_PATH', 'cookies.txt')
    if os.path.isfile(cookie_file):
        opts['cookiefile'] = cookie_file
    elif os.path.isfile(os.path.join(os.path.dirname(os.path.dirname(__file__)), 'cookies.txt')):
        opts['cookiefile'] = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'cookies.txt')

    # Proxy support from Settings
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
            if p_url:
                opts['proxy'] = p_url
    except Exception:
        pass

    return opts

def extract_media_info(url: str) -> Dict[str, Any]:
    """Universal info extraction prioritizing high-bitrate video and lossless audio tracks."""
    ydl_opts = {
        'skip_download': True,
        'extract_flat': False,
        **get_base_ydl_opts()
    }
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            
            title = info.get('title', 'Unknown Media')
            duration = format_duration(info.get('duration'))
            creator = info.get('uploader', info.get('channel', 'Unknown Creator'))
            
            thumbnails = info.get('thumbnails', [])
            thumbnail = thumbnails[-1].get('url', '') if thumbnails else info.get('thumbnail', '')
            
            formats_list = info.get('formats', [])
            parsed_formats = []
            
            # Filter and sort video formats
            video_formats = [f for f in formats_list if f.get('vcodec') != 'none' and f.get('height')]
            
            def sort_v(f):
                h = f.get('height') or 0
                vcodec = (f.get('vcodec') or '').lower()
                is_h264 = 1 if (vcodec.startswith(('avc1', 'h264', 'mp4v')) or 'h264' in vcodec) else 0
                tbr = f.get('tbr') or 0
                return (h, is_h264, tbr)

            video_formats.sort(key=sort_v, reverse=True)
            
            seen_heights = set()
            for f in video_formats:
                height = f.get('height')
                if not height:
                    continue
                
                if height >= 2160:
                    res_label = "4K UHD (2160p)"
                    res_bucket = 2160
                elif height >= 1440:
                    res_label = "1440p QHD"
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
                else:
                    res_label = f"{height}p"
                    res_bucket = height
                    
                if res_bucket in seen_heights:
                    continue
                seen_heights.add(res_bucket)
                
                vsize = f.get('filesize') or f.get('filesize_approx')
                asize = 128 * 1024 * (info.get('duration', 0) or 0) / 8
                total_size = vsize + asize if vsize else None
                
                parsed_formats.append({
                    "id": str(f.get('format_id')),
                    "format": "MP4",
                    "resolution": res_label,
                    "size": format_size(total_size) if total_size else "Adaptive Size",
                    "bitrate": f"{int(f.get('tbr', 0))} kbps" if f.get('tbr') else "Variable"
                })
                
            # Audio formats
            if formats_list:
                parsed_formats.append({
                    "id": "bestaudio-mp3",
                    "format": "MP3",
                    "resolution": "Audio 320kbps (MP3)",
                    "size": format_size(320 * 1024 * (info.get('duration', 0) or 0) / 8) if info.get('duration') else "Adaptive Size",
                    "bitrate": "320 kbps"
                })
                parsed_formats.append({
                    "id": "bestaudio-m4a",
                    "format": "M4A",
                    "resolution": "Audio 192kbps (AAC/M4A)",
                    "size": format_size(192 * 1024 * (info.get('duration', 0) or 0) / 8) if info.get('duration') else "Adaptive Size",
                    "bitrate": "192 kbps"
                })
                
            return {
                "title": title,
                "duration": duration,
                "creator": creator,
                "thumbnail": thumbnail,
                "originalUrl": url,
                "formats": parsed_formats,
                "success": True
            }
    except Exception as e:
        return {"error": str(e), "success": False}

def ensure_mp4_faststart(file_path: str):
    """Normalize container to standard AAC audio + faststart to eliminate player stutter."""
    if not file_path.lower().endswith('.mp4') or not os.path.isfile(file_path):
        return
    try:
        probe_cmd = ['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'json', file_path]
        p = subprocess.run(probe_cmd, capture_output=True, text=True)
        if p.returncode == 0:
            data = json.loads(p.stdout)
            streams = data.get('streams', [])
            needs_audio_fix = any(s.get('codec_type') == 'audio' and s.get('codec_name') in ['opus', 'vorbis', 'flac'] for s in streams)
            
            if needs_audio_fix:
                tmp_path = file_path + ".fixed.mp4"
                ffmpeg_cmd = [
                    'ffmpeg', '-y', '-i', file_path,
                    '-c:v', 'copy',
                    '-c:a', 'aac', '-b:a', '192k',
                    '-movflags', '+faststart',
                    tmp_path
                ]
                fix_res = subprocess.run(ffmpeg_cmd, capture_output=True)
                if fix_res.returncode == 0 and os.path.exists(tmp_path):
                    os.replace(tmp_path, file_path)
    except Exception:
        pass

def download_stream(
    url: str,
    format_id: str,
    output_path: str,
    progress_callback: Optional[Callable[[float, str, str, str, int, int], None]] = None,
    cancel_flag: Optional[Callable[[], bool]] = None
):
    output_path = os.path.abspath(output_path)
    base_dir = os.path.dirname(output_path)
    os.makedirs(base_dir, exist_ok=True)
    
    file_name_no_ext = os.path.basename(output_path).split('.')[0]
    outtmpl = os.path.join(base_dir, file_name_no_ext + '.%(ext)s')
    
    is_audio = 'audio' in format_id.lower() or 'mp3' in format_id.lower() or 'm4a' in format_id.lower() or output_path.lower().endswith(('.mp3', '.m4a'))
    
    # 1. Determine format selector
    ydl_opts_base = {
        'outtmpl': outtmpl,
        'quiet': True,
        'no_warnings': True,
        'noplaylist': True,
        'buffersize': 1024 * 1024 * 8,
        'retries': 10,
        **get_base_ydl_opts()
    }

    if is_audio:
        codec = 'm4a' if ('m4a' in format_id.lower() or output_path.lower().endswith('.m4a')) else 'mp3'
        ydl_opts_base.update({
            'format': 'bestaudio/best',
            'postprocessors': [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': codec,
                'preferredquality': '320',
            }]
        })
    else:
        res_match = re.search(r'(\d{3,4})', str(format_id))
        if res_match and int(res_match.group(1)) in [2160, 1440, 1080, 720, 480, 360]:
            h = int(res_match.group(1))
            format_selector = (
                f"bestvideo[height<={h}][vcodec^=avc1]+bestaudio[ext=m4a]/"
                f"bestvideo[height<={h}][vcodec^=avc]+bestaudio[ext=m4a]/"
                f"bestvideo[height<={h}]+bestaudio/"
                f"best[height<={h}]/best"
            )
        elif str(format_id).isdigit():
            format_selector = f"{format_id}+bestaudio[ext=m4a]/{format_id}+bestaudio/best"
        else:
            format_selector = "bestvideo[vcodec^=avc1]+bestaudio/bestvideo+bestaudio/best"
            
        ydl_opts_base['format'] = format_selector
        ydl_opts_base['merge_output_format'] = 'mp4'
        ydl_opts_base['postprocessor_args'] = {
            'merger': ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']
        }

    # 2. Pre-extract expected formats and sizes so multi-stream progress never jumps or stalls
    known_format_sizes: Dict[str, int] = {}
    total_expected_bytes = 0
    try:
        probe_opts = {**ydl_opts_base, 'skip_download': True}
        with yt_dlp.YoutubeDL(probe_opts) as probe_ydl:
            probe_info = probe_ydl.extract_info(url, download=False)
            rf = probe_info.get('requested_formats') or [probe_info]
            for f in rf:
                fid = str(f.get('format_id') or '')
                sz = f.get('filesize') or f.get('filesize_approx') or 0
                if sz <= 0 and f.get('tbr') and probe_info.get('duration'):
                    sz = int(float(f['tbr']) * 1024 * float(probe_info['duration']) / 8)
                if sz > 0:
                    known_format_sizes[fid] = sz
            total_expected_bytes = sum(known_format_sizes.values())
    except Exception:
        pass

    stream_bytes: Dict[str, Dict[str, int]] = {}
    last_p = [0.0]

    def hook(d):
        if cancel_flag and cancel_flag():
            raise Exception("Download cancelled by user")
            
        stream_id = d.get('tmpfilename') or d.get('filename') or 'stream'
        info_dict = d.get('info_dict') or {}
        f_id = str(info_dict.get('format_id') or '')

        if d['status'] == 'downloading':
            total = d.get('total_bytes') or d.get('total_bytes_estimate') or known_format_sizes.get(f_id) or 0
            downloaded = d.get('downloaded_bytes') or 0
            
            stream_bytes[stream_id] = {
                'downloaded': downloaded,
                'total': total
            }
            
            all_downloaded = sum(s['downloaded'] for s in stream_bytes.values())
            all_total = max(total_expected_bytes, sum(s['total'] for s in stream_bytes.values() if s['total'] > 0))
            
            if all_total > 0:
                calc_percent = (all_downloaded / all_total) * 98.0
                effective_p = min(98.0, max(0.0, calc_percent))
            else:
                raw_pct_str = d.get('_percent_str', '').replace('%', '').strip()
                try:
                    raw_percent = float(raw_pct_str) if raw_pct_str else 0.0
                except Exception:
                    raw_percent = 0.0
                effective_p = min(98.0, max(0.0, raw_percent * 0.98))
                
            effective_p = max(last_p[0], effective_p)
            last_p[0] = effective_p
            speed = format_speed(d.get('speed'))
            eta = f"{int(d['eta'])}s" if d.get('eta') else "--"
            
            if progress_callback:
                progress_callback(round(effective_p, 1), speed, eta, 'downloading', all_downloaded, all_total)
                
        elif d['status'] == 'finished':
            if stream_id in stream_bytes and stream_bytes[stream_id]['total'] > 0:
                stream_bytes[stream_id]['downloaded'] = stream_bytes[stream_id]['total']
            else:
                total = d.get('total_bytes') or known_format_sizes.get(f_id) or 0
                stream_bytes[stream_id] = {'downloaded': total, 'total': total}
                
            all_downloaded = sum(s['downloaded'] for s in stream_bytes.values())
            all_total = max(total_expected_bytes, sum(s['total'] for s in stream_bytes.values() if s['total'] > 0))
            
            # Check if all expected streams have completed
            all_streams_done = (all_total > 0 and all_downloaded >= all_total) or (len(stream_bytes) >= max(1, len(known_format_sizes)))
            
            if all_streams_done:
                effective_p = min(99.0, max(last_p[0], 98.5))
            else:
                calc_percent = (all_downloaded / all_total * 98.0) if all_total > 0 else last_p[0]
                effective_p = max(last_p[0], calc_percent)

            last_p[0] = effective_p
            
            if progress_callback:
                progress_callback(round(effective_p, 1), 'Muxing', 'a few secs', 'stitching', all_downloaded, all_total)

    ydl_opts = {
        **ydl_opts_base,
        'progress_hooks': [hook]
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])

    # Reconcile final output file path
    final_size = sum(s['downloaded'] for s in stream_bytes.values())
    if os.path.exists(output_path):
        ensure_mp4_faststart(output_path)
        try:
            final_size = os.path.getsize(output_path)
        except Exception:
            pass
        if progress_callback:
            progress_callback(100.0, 'Completed', '0s', 'completed', final_size, final_size)
        return output_path

    for f in os.listdir(base_dir):
        if f.startswith(file_name_no_ext):
            actual = os.path.join(base_dir, f)
            if actual != output_path:
                if os.path.exists(output_path):
                    os.remove(output_path)
                os.rename(actual, output_path)
            ensure_mp4_faststart(output_path)
            try:
                final_size = os.path.getsize(output_path)
            except Exception:
                pass
            if progress_callback:
                progress_callback(100.0, 'Completed', '0s', 'completed', final_size, final_size)
            return output_path

    raise Exception(f"Output file not generated in {base_dir}")
