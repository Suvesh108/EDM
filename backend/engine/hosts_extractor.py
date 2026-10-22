import re
import json
import httpx
from typing import Dict, Any, Optional, List
from urllib.parse import urlparse, quote

def unpack_js(packed_code: str) -> str:
    """
    Python port of Dean Edwards' JavaScript Packer Unpacker.
    Decodes eval(function(p,a,c,k,e,d)...) blocks.
    """
    try:
        match = re.search(r"}\s*\('(.*)',\s*(\d+),\s*(\d+),\s*'(.*)'\.split\('\|'\)", packed_code)
        if not match:
            return packed_code

        payload = match.group(1)
        radix = int(match.group(2))
        count = int(match.group(3))
        symtab = match.group(4).split('|')

        def encode(c):
            def _enc(n):
                return "" if n < radix else _enc(n // radix) + (chr(n % radix + 29) if n % radix > 35 else "0123456789abcdefghijklmnopqrstuvwxyz"[n % radix])
            res = _enc(c)
            return res if res else "0"

        for i in reversed(range(count)):
            if i < len(symtab) and symtab[i]:
                word = encode(i)
                payload = re.sub(rf'\b{re.escape(word)}\b', symtab[i], payload)

        return payload
    except Exception:
        return packed_code

def identify_host(url: str) -> Dict[str, Any]:
    try:
        host = urlparse(url).netloc.lower()
        if any(h in host for h in ['terabox', '1024tera', '4funbox', 'mirrobox', 'nephobox', 'freeterabox', 'tibox']):
            return {'hostName': 'TeraBox', 'isSupported': True}
        if 'diskwala' in host or 'diskwla' in host:
            return {'hostName': 'DiskWala', 'isSupported': True}
        if 'dood' in host or 'ds2play' in host:
            return {'hostName': 'DoodStream', 'isSupported': True}
        if any(h in host for h in ['streamtape', 'streamta.pe', 'tapecontent', 'strtape', 'strcloud']):
            return {'hostName': 'Streamtape', 'isSupported': True}
        if 'filemoon' in host:
            return {'hostName': 'FileMoon', 'isSupported': True}
        if 'vidbunker' in host:
            return {'hostName': 'VidBunker', 'isSupported': True}
        if 'bytedisk' in host or 'bytebox' in host:
            return {'hostName': 'ByteDisk', 'isSupported': True}
        if any(h in host for h in ['streamwish', 'swhls', 'wishfast', 'wishembed', 'hlswish', 'embedwish']):
            return {'hostName': 'StreamWish', 'isSupported': True}
        if 'vidhide' in host:
            return {'hostName': 'Vidhide', 'isSupported': True}
        if 'filelions' in host:
            return {'hostName': 'FileLions', 'isSupported': True}
        if 'mixdrop' in host:
            return {'hostName': 'MixDrop', 'isSupported': True}
        if 'streamhg' in host or 'hgstreams' in host:
            return {'hostName': 'StreamHG', 'isSupported': True}
        if any(h in host for h in ['vidguard', 'vgembed', 'listvid', 'v6embed']):
            return {'hostName': 'VidGuard', 'isSupported': True}
        if 'upstream' in host:
            return {'hostName': 'Upstream', 'isSupported': True}
        if 'voe' in host or 'repackcf' in host:
            return {'hostName': 'VOE', 'isSupported': True}
        if any(h in host for h in ['streamsb', 'sbchill', 'sbfull', 'sbfast', 'sbembed', 'sbvideo', 'sblona', 'watchsb']):
            return {'hostName': 'StreamSB', 'isSupported': True}
        if any(h in host for h in ['rou.video', 'embed', 'player', 'watch']):
            return {'hostName': 'Video Aggregator', 'isSupported': True, 'isAggregator': True}
    except Exception:
        pass
    return {'hostName': 'Generic Media', 'isSupported': False}

async def extract_hosting_media(url: str) -> Optional[Dict[str, Any]]:
    host_info = identifyHost(url) if 'identifyHost' in globals() else identify_host(url)
    if not host_info.get('isSupported'):
        return None

    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': url
    }

    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True, headers=headers) as client:
        # 1. TeraBox
        if host_info['hostName'] == 'TeraBox':
            terabox_apis = [
                f"https://terabox-api.syndr.workers.dev/?url={quote(url)}",
                f"https://ytbvideolyrics.com/api/terabox?url={quote(url)}"
            ]
            for api in terabox_apis:
                try:
                    res = await client.get(api)
                    if res.status_code == 200:
                        data = res.json()
                        file = data[0] if isinstance(data, list) and data else (data.get('list', [{}])[0] or data)
                        direct = file.get('download_link') or file.get('dlink') or file.get('url') or file.get('direct_link')
                        if direct:
                            title = file.get('file_name') or file.get('filename') or 'TeraBox_Download.mp4'
                            return {
                                "title": title,
                                "duration": "Cloud File",
                                "creator": "TeraBox",
                                "thumbnail": file.get('thumbnail', ''),
                                "originalUrl": url,
                                "formats": [{
                                    "id": "terabox-direct",
                                    "format": "MP4",
                                    "resolution": "Original Cloud Quality",
                                    "size": f"{round(file.get('size', 0) / (1024*1024), 1)} MB" if file.get('size') else "Adaptive Size",
                                    "bitrate": "High Speed",
                                    "directUrl": direct
                                }]
                            }
                except Exception:
                    pass

        # 2. Generic Packed Video Host (Streamtape, FileMoon, StreamWish, MixDrop, VOE, etc.)
        try:
            res = await client.get(url)
            html = res.text

            # Look for packed JS blocks
            packed_blocks = re.findall(r"(eval\(function\(p,a,c,k,e,d\)[\s\S]*?\.split\('\|'\)\)\))", html)
            unpacked_text = ""
            for block in packed_blocks:
                unpacked_text += "\n" + unpack_js(block)

            search_scope = html + "\n" + unpacked_text

            # Search for direct m3u8 or mp4 URLs
            stream_matches = re.findall(r'(https?://[^\s"\'<>]+\.(?:m3u8|mp4)(?:\?[^\s"\'<>]*)?)', search_scope)
            if stream_matches:
                direct_stream = stream_matches[0]
                title_match = re.search(r'<title>(.*?)</title>', html, re.IGNORECASE)
                title = title_match.group(1).strip() if title_match else f"{host_info['hostName']} Video"
                return {
                    "title": title,
                    "duration": "Stream",
                    "creator": host_info['hostName'],
                    "thumbnail": "",
                    "originalUrl": url,
                    "formats": [{
                        "id": "host-direct",
                        "format": "MP4",
                        "resolution": "1080p Stream",
                        "size": "Adaptive Stream",
                        "bitrate": "Direct CDN",
                        "directUrl": direct_stream
                    }]
                }
        except Exception:
            pass

    return None
