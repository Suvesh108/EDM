import os
import re
from urllib.parse import urlparse
from typing import Dict, Any

def detect_file_category(url: str) -> Dict[str, Any]:
    clean_url = url.strip().lower()
    
    # 1. Torrents & Magnets
    if clean_url.startswith("magnet:?") or clean_url.endswith('.torrent'):
        return {
            'category': 'TORRENT',
            'target_extension': 'torrent',
            'pack_name': 'BitTorrentPack',
            'label': 'BitTorrent Swarm'
        }

    # 2. eD2k
    if clean_url.startswith('ed2k://'):
        return {
            'category': 'DIRECT',
            'target_extension': 'bin',
            'pack_name': 'ED2kPack',
            'label': 'eDonkey2000 URI'
        }

    # 3. FTP / FTPS
    if clean_url.startswith(('ftp://', 'ftps://')):
        return {
            'category': 'DIRECT',
            'target_extension': 'bin',
            'pack_name': 'FtpPack',
            'label': 'FTP Stream'
        }

    # 4. GitHub Releases & Raw
    if 'github.com' in clean_url and ('/releases/' in clean_url or '/raw/' in clean_url):
        return {
            'category': 'DIRECT',
            'target_extension': clean_url.split('.')[-1] if '.' in clean_url else 'bin',
            'pack_name': 'GitHubPack',
            'label': 'GitHub Release Asset'
        }

    # 5. HuggingFace Models & Datasets
    if 'huggingface.co' in clean_url and ('/resolve/' in clean_url or '/blob/' in clean_url or any(e in clean_url for e in ['.safetensors', '.gguf', '.onnx', '.bin'])):
        return {
            'category': 'DIRECT',
            'target_extension': clean_url.split('.')[-1] if '.' in clean_url else 'safetensors',
            'pack_name': 'HuggingFacePack',
            'label': 'AI Weights CDN'
        }

    # 6. HLS Stream M3U8
    if '.m3u8' in clean_url:
        return {
            'category': 'VIDEO',
            'target_extension': 'mp4',
            'pack_name': 'M3U8Pack',
            'label': 'HLS Adaptive Playlist'
        }

    # 7. Major Video Platforms
    video_domains = [
        'youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com',
        'twitter.com', 'x.com', 'vimeo.com', 'dailymotion.com',
        'twitch.tv', 'reddit.com/r/', 'facebook.com', 'fb.watch'
    ]
    if any(d in clean_url for d in video_domains):
        return {
            'category': 'VIDEO',
            'target_extension': 'mp4',
            'pack_name': 'YouTubePack',
            'label': 'Video Stream'
        }

    # 8. Audio Platforms
    audio_domains = ['soundcloud.com', 'bandcamp.com', 'spotify.com', 'mixcloud.com', 'audiomack.com']
    if any(d in clean_url for d in audio_domains):
        return {
            'category': 'AUDIO',
            'target_extension': 'm4a',
            'pack_name': 'YouTubePack',
            'label': 'Audio Track'
        }

    # 9. Direct File Extensions
    path = clean_url.split('?')[0].split('#')[0]
    ext_match = re.search(r'(\.[a-zA-Z0-9]+)$', path)
    if ext_match:
        file_ext = ext_match.group(1).lower()
        cat_folder = get_categorization_folder(file_ext)
        if cat_folder == 'video':
            return {'category': 'VIDEO', 'target_extension': file_ext.lstrip('.'), 'pack_name': 'HttpPack', 'label': 'Direct Video'}
        elif cat_folder == 'audio':
            return {'category': 'AUDIO', 'target_extension': file_ext.lstrip('.'), 'pack_name': 'HttpPack', 'label': 'Direct Audio'}
        elif cat_folder == 'archives':
            return {'category': 'ZIP', 'target_extension': file_ext.lstrip('.'), 'pack_name': 'HttpPack', 'label': 'Archive Package'}
        elif cat_folder == 'documents':
            return {'category': 'DOCUMENT', 'target_extension': file_ext.lstrip('.'), 'pack_name': 'HttpPack', 'label': 'Document'}
        elif cat_folder == 'image':
            return {'category': 'PHOTO', 'target_extension': file_ext.lstrip('.'), 'pack_name': 'HttpPack', 'label': 'Image'}
        elif cat_folder == 'program':
            return {'category': 'DIRECT', 'target_extension': file_ext.lstrip('.'), 'pack_name': 'HttpPack', 'label': 'Executable / Program'}
        elif cat_folder == 'subtitles':
            return {'category': 'DIRECT', 'target_extension': file_ext.lstrip('.'), 'pack_name': 'HttpPack', 'label': 'Subtitle File'}

    return {
        'category': 'DIRECT',
        'target_extension': 'bin',
        'pack_name': 'HttpPack',
        'label': 'Direct Download Link'
    }

# --- Canonical 8-Category Rules with Exact File Extension Lists ---
CATEGORIZATION_MAP = {
    'video': {
        '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg',
        '.3gp', '.ts', '.m2ts', '.mts', '.vob', '.ogv', '.divx', '.asf', '.rmvb', '.f4v'
    },
    'audio': {
        '.mp3', '.flac', '.wav', '.aac', '.ogg', '.wma', '.m4a', '.opus', '.aiff', '.alac',
        '.mid', '.midi'
    },
    'image': {
        '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tiff', '.tif', '.ico',
        '.heic', '.heif', '.avif'
    },
    'subtitles': {
        '.srt', '.ass', '.ssa', '.sub', '.vtt', '.sbv', '.idx', '.sup', '.smi', '.lrc'
    },
    'documents': {
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf', '.odt',
        '.ods', '.odp', '.csv', '.md', '.tex', '.epub', '.mobi', '.pages', '.wps'
    },
    'archives': {
        '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.zst', '.lz', '.lzma',
        '.cab', '.iso', '.img', '.dmg', '.tgz', '.tbz2', '.txz', '.br', '.arj', '.ace',
        '.lzh', '.cpio', '.deb', '.rpm'
    },
    'program': {
        '.exe', '.msi', '.msu', '.msp', '.appx', '.msix', '.appxbundle', '.msixbundle',
        '.bat', '.cmd', '.com', '.scr', '.sys', '.dll', '.ocx', '.jar', '.apk', '.app',
        '.pkg'
    }
}

def get_categorization_folder(extension_or_filename: str) -> str:
    """Classifies a filename or extension into one of 8 standard subfolders:
    video, audio, image, subtitles, documents, archives, program, or other."""
    if not extension_or_filename:
        return 'other'
    ext = os.path.splitext(extension_or_filename)[1].lower()
    if not ext and extension_or_filename:
        ext = '.' + extension_or_filename.lstrip('.').lower()
    for category, ext_set in CATEGORIZATION_MAP.items():
        if ext in ext_set:
            return category
    return 'other'
