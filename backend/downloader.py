import sys
import json
import os
import re

# Hook static-ffmpeg path if available
try:
    import static_ffmpeg
    static_ffmpeg.add_paths()
except ImportError:
    pass

import yt_dlp

def format_duration(seconds):
    if not seconds:
        return "00:00"
    try:
        seconds = int(seconds)
        h = seconds // 3600
        m = (seconds % 3600) // 60
        s = seconds % 60
        if h > 0:
            return f"{h:02d}:{m:02d}:{s:02d}"
        else:
            return f"{m:02d}:{s:02d}"
    except Exception:
        return "00:00"

def format_size(bytes_num):
    if not bytes_num:
        return "N/A"
    try:
        bytes_num = float(bytes_num)
        for unit in ['B', 'KB', 'MB', 'GB']:
            if bytes_num < 1024.0:
                return f"{bytes_num:.1f} {unit}"
            bytes_num /= 1024.0
        return f"{bytes_num:.1f} TB"
    except Exception:
        return "N/A"

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

def get_cookie_opts():
    cookie_opts = {}
    
    # Base stealth headers to evade bot detection
    cookie_opts['http_headers'] = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-CH-UA': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
        'Sec-CH-UA-Mobile': '?0',
        'Sec-CH-UA-Platform': '"Windows"',
    }

    # Remote components to pull up-to-date JS player decryptors
    cookie_opts['remote_components'] = {'ejs:github'}
    cookie_opts['js_runtimes'] = {'node': {}}

    # 1. Custom cookies.txt path from env or local backend dir
    cookie_file = os.getenv('YTDLP_COOKIES_PATH', 'cookies.txt')
    if os.path.isfile(cookie_file):
        cookie_opts['cookiefile'] = cookie_file
    elif os.path.isfile(os.path.join(os.path.dirname(__file__), 'cookies.txt')):
        cookie_opts['cookiefile'] = os.path.join(os.path.dirname(__file__), 'cookies.txt')

    # 2. Browser cookies option
    browser = os.getenv('YTDLP_COOKIES_BROWSER')
    if browser:
        cookie_opts['cookiesfrombrowser'] = (browser,)

    # 3. Raw cookie string in env
    raw_cookie = os.getenv('YTDLP_RAW_COOKIE')
    if raw_cookie:
        cookie_opts['http_headers']['Cookie'] = raw_cookie
        
    return cookie_opts

def extract_info(url):
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'skip_download': True,
        'extract_flat': False,
        'noplaylist': True,
        **get_cookie_opts()
    }
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            
            # Format title, duration, creator, thumbnail
            title = info.get('title', 'Unknown Title')
            duration = format_duration(info.get('duration'))
            creator = info.get('uploader', info.get('channel', 'Unknown Creator'))
            
            # Find best thumbnail
            thumbnails = info.get('thumbnails', [])
            thumbnail = ""
            if thumbnails:
                # Prefer high res
                thumbnail = thumbnails[-1].get('url', '')
            if not thumbnail:
                thumbnail = info.get('thumbnail', '')
                
            # Parse available formats
            formats_list = info.get('formats', [])
            parsed_formats = []
            
            # Filter video formats
            video_formats = [f for f in formats_list if f.get('vcodec') != 'none' and f.get('height')]
            
            # Sort video formats prioritizing:
            # 1. Height descending (higher resolution first)
            # 2. H.264 / AVC codec (universal compatibility in built-in players)
            # 3. Total bitrate (tbr)
            def video_sort_key(f):
                h = f.get('height') or 0
                vcodec = (f.get('vcodec') or '').lower()
                is_h264 = 1 if (vcodec.startswith(('avc1', 'h264', 'mp4v')) or 'h264' in vcodec) else 0
                tbr = f.get('tbr') or 0
                return (h, is_h264, tbr)

            video_formats.sort(key=video_sort_key, reverse=True)
            
            seen_resolutions = set()
            for f in video_formats:
                height = f.get('height')
                if not height:
                    continue
                
                # Group by standard resolutions
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
                    
                if res_bucket in seen_resolutions:
                    continue
                seen_resolutions.add(res_bucket)
                
                # Estimate size if not present (video size + approximate audio size 128kbps)
                vsize = f.get('filesize') or f.get('filesize_approx')
                asize = 128 * 1024 * (info.get('duration', 0) or 0) / 8 # approx audio size
                total_size = vsize + asize if vsize else None
                
                parsed_formats.append({
                    "id": str(f.get('format_id')),
                    "format": "MP4",
                    "resolution": res_label,
                    "size": format_size(total_size) if total_size else "Adaptive Size",
                    "bitrate": f"{int(f.get('tbr', 0))} kbps" if f.get('tbr') else "Variable"
                })
                
            # Add audio formats (AAC / MP3)
            audio_formats = [f for f in formats_list if f.get('acodec') != 'none' and f.get('vcodec') == 'none']
            if audio_formats or formats_list:
                parsed_formats.append({
                    "id": "bestaudio",
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
                
            result = {
                "title": title,
                "duration": duration,
                "creator": creator,
                "thumbnail": thumbnail,
                "originalUrl": url,
                "formats": parsed_formats
            }
            return result
            
    except Exception as e:
        return {"error": str(e)}

def create_progress_hook(progress_callback=None):
    last_percent = [0.0]
    def hook(d):
        if d['status'] == 'downloading':
            total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
            downloaded = d.get('downloaded_bytes') or 0
            raw_percent = 0.0
            if total > 0:
                raw_percent = (downloaded / total) * 100.0
                
            info = d.get('info_dict') or {}
            vcodec = info.get('vcodec')
            acodec = info.get('acodec')
            
            if vcodec and vcodec != 'none' and acodec == 'none':
                effective_percent = min(88.0, raw_percent * 0.88)
            elif acodec and acodec != 'none' and (not vcodec or vcodec == 'none'):
                effective_percent = min(99.0, 88.0 + (raw_percent * 0.11))
            else:
                effective_percent = min(99.0, raw_percent)
                
            if effective_percent > last_percent[0]:
                last_percent[0] = effective_percent
            else:
                effective_percent = last_percent[0]
                
            speed = d.get('speed')
            speed_str = format_speed(speed)
            eta = d.get('eta')
            eta_str = f"{int(eta)}s" if eta else "--"
            
            if progress_callback:
                progress_callback(round(effective_percent, 1), speed_str, eta_str, 'downloading')
            print(f"[PROGRESS] {effective_percent:.1f}% | SPEED: {speed_str} | ETA: {eta_str}", flush=True)
        elif d['status'] == 'finished':
            if progress_callback:
                progress_callback(99.0, 'Muxing', '0s', 'stitching')
            print("[PROGRESS] 99.0% | Stitching and compiling streams...", flush=True)
    return hook

def ensure_mp4_compatibility(file_path):
    """Ensures MP4 has H.264/AAC and +faststart so any native media player plays it smoothly without jitter."""
    if not file_path.lower().endswith('.mp4') or not os.path.isfile(file_path):
        return
    try:
        import subprocess
        probe_cmd = ['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'json', file_path]
        p = subprocess.run(probe_cmd, capture_output=True, text=True)
        if p.returncode == 0:
            data = json.loads(p.stdout)
            streams = data.get('streams', [])
            needs_audio_fix = False
            for s in streams:
                if s.get('codec_type') == 'audio' and s.get('codec_name') in ['opus', 'vorbis', 'flac']:
                    needs_audio_fix = True
            
            if needs_audio_fix:
                print("[STATUS] Transcoding incompatible audio stream to standard AAC...", flush=True)
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
                    print("[STATUS] Audio normalized to AAC successfully.", flush=True)
                elif os.path.exists(tmp_path):
                    os.remove(tmp_path)
    except Exception as e:
        print(f"[WARNING] Compatibility check warning: {e}", flush=True)

def download_media(url, format_id, output_path, progress_callback=None):
    # Setup download options
    output_path = os.path.abspath(output_path)
    base_dir = os.path.dirname(output_path)
    file_name_no_ext = os.path.basename(output_path)
    outtmpl_path = os.path.join(base_dir, file_name_no_ext.split('.')[0] + '.%(ext)s')

    format_id_str = str(format_id).strip()
    is_audio = any(a in format_id_str.lower() for a in ['audio', 'mp3', 'm4a', 'aac']) or output_path.lower().endswith(('.mp3', '.m4a'))

    ydl_opts = {
        'progress_hooks': [create_progress_hook(progress_callback)],
        'outtmpl': outtmpl_path,
        'quiet': True,
        'no_warnings': True,
        'noplaylist': True,
        'concurrent_fragment_downloads': 16,
        'buffersize': 1024 * 1024 * 16,
        'http_chunk_size': 10485760,
        'continuedl': True,
        'retries': 10,
        'fragment_retries': 10,
        **get_cookie_opts()
    }

    if is_audio:
        codec = 'm4a' if ('m4a' in format_id_str.lower() or 'aac' in format_id_str.lower() or output_path.lower().endswith('.m4a')) else 'mp3'
        quality = '320'
        ydl_opts.update({
            'format': 'bestaudio/best',
            'postprocessors': [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': codec,
                'preferredquality': quality,
            }]
        })
    else:
        # Determine target resolution height if format_id contains digits (e.g. 'loader-1080', '1080p', '720')
        res_match = re.search(r'(\d{3,4})', format_id_str)
        if res_match and int(res_match.group(1)) in [2160, 1440, 1080, 720, 480, 360, 240, 144]:
            h = int(res_match.group(1))
            format_selector = (
                f"bestvideo[height<={h}][vcodec^=avc1]+bestaudio[ext=m4a]/"
                f"bestvideo[height<={h}][vcodec^=avc]+bestaudio[ext=m4a]/"
                f"bestvideo[height<={h}][vcodec^=avc1]+bestaudio/"
                f"bestvideo[height<={h}]+bestaudio[ext=m4a]/"
                f"bestvideo[height<={h}]+bestaudio/"
                f"best[height<={h}]/best"
            )
        elif format_id_str.isdigit():
            # Specific numeric yt-dlp format id
            format_selector = f"{format_id_str}+bestaudio[ext=m4a]/{format_id_str}+bestaudio/best"
        elif format_id_str == 'best':
            format_selector = (
                "bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/"
                "bestvideo[vcodec^=avc]+bestaudio[ext=m4a]/"
                "bestvideo+bestaudio[ext=m4a]/"
                "bestvideo+bestaudio/best"
            )
        else:
            format_selector = "bestvideo[vcodec^=avc1]+bestaudio/bestvideo+bestaudio/best"
            
        ydl_opts['format'] = format_selector
        ydl_opts['merge_output_format'] = 'mp4'
        # Crucial for zero-jitter and 100% playable MP4 in Windows Media Player & Android:
        # 1. Transcode audio to AAC (eliminates Opus-in-MP4 decode failures and desync jitter)
        # 2. Add +faststart (moves moov atom to beginning for instant, jitter-free playback)
        ydl_opts['postprocessor_args'] = {
            'merger': [
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-movflags', '+faststart'
            ],
            'ffmpeg': [
                '-movflags', '+faststart'
            ]
        }

    try:
        print(f"[STATUS] Initializing stream download payload...", flush=True)
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
            
        # Check if file was saved directly to output_path
        if os.path.exists(output_path):
            ensure_mp4_compatibility(output_path)
            print(f"[SUCCESS] Download completed. Saved to {output_path}", flush=True)
            return

        # Scan folder for files starting with base_name_no_ext
        base_name_no_ext = file_name_no_ext.split('.')[0]
        for file in os.listdir(base_dir):
            if file.startswith(base_name_no_ext):
                actual_path = os.path.join(base_dir, file)
                if actual_path != output_path:
                    if os.path.exists(output_path):
                        os.remove(output_path)
                    os.rename(actual_path, output_path)
                
                # Extra compatibility safeguard
                ensure_mp4_compatibility(output_path)
                print(f"[SUCCESS] Download completed. Saved to {output_path}", flush=True)
                return
                
        print(f"[ERROR] Could not find the output file in directory {base_dir}", flush=True)
    except Exception as e:
        print(f"[ERROR] Download failed: {str(e)}", flush=True)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python downloader.py [info|download] [args...]")
        sys.exit(1)
        
    cmd = sys.argv[1]
    
    if cmd == "info":
        url = sys.argv[2]
        res = extract_info(url)
        print(json.dumps(res))
    elif cmd == "download":
        if len(sys.argv) < 5:
            print("Usage: python downloader.py download [url] [format_id] [output_path]")
            sys.exit(1)
        url = sys.argv[2]
        format_id = sys.argv[3]
        output_path = sys.argv[4]
        download_media(url, format_id, output_path)
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
