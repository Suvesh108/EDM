import re
import httpx
from typing import Dict, Any, List, Optional
from urllib.parse import urlparse, parse_qs

class BiliPack:
    """
    Bilibili Video & Audio Stream Feature Pack.
    Supports:
    - BV / AV / Ep ID parsing
    - QR Code login generator & status polling (to obtain SESSDATA for VIP 1080p60/4K/8K formats)
    - Danmaku XML extraction
    """
    BV_PATTERN = re.compile(r"(BV[1-9A-HJ-NP-Za-km-z]{10})", re.IGNORECASE)
    AV_PATTERN = re.compile(r"av(\d+)", re.IGNORECASE)
    EP_PATTERN = re.compile(r"ep(\d+)", re.IGNORECASE)

    def is_bilibili_url(self, url: str) -> bool:
        return 'bilibili.com' in url.lower() or 'b23.tv' in url.lower()

    def parse_id(self, url: str) -> Dict[str, Any]:
        bv_match = self.BV_PATTERN.search(url)
        if bv_match:
            return {'isValid': True, 'type': 'BV', 'id': bv_match.group(1)}
        av_match = self.AV_PATTERN.search(url)
        if av_match:
            return {'isValid': True, 'type': 'AV', 'id': av_match.group(1)}
        ep_match = self.EP_PATTERN.search(url)
        if ep_match:
            return {'isValid': True, 'type': 'EP', 'id': ep_match.group(1)}
        return {'isValid': False, 'error': 'No valid Bilibili video ID (BV/AV/EP) found.'}

    async def generate_qr_login(self) -> Dict[str, Any]:
        """Request a QR code key and authentication URL from Bilibili Passport API."""
        url = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134.0.0.0 Safari/537.36",
            "Referer": "https://www.bilibili.com"
        }
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.get(url, headers=headers)
            if res.status_code == 200:
                data = res.json().get('data', {})
                return {
                    'success': True,
                    'qrcodeKey': data.get('qrcode_key', ''),
                    'authUrl': data.get('url', '')
                }
        return {'success': False, 'error': 'Failed to generate Bilibili QR code'}

    async def poll_qr_status(self, qrcode_key: str) -> Dict[str, Any]:
        """Poll Bilibili Passport to check if the user scanned and confirmed the QR code."""
        url = f"https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key={qrcode_key}"
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134.0.0.0 Safari/537.36",
            "Referer": "https://www.bilibili.com"
        }
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.get(url, headers=headers)
            if res.status_code == 200:
                body = res.json()
                code = body.get('data', {}).get('code', -1)
                message = body.get('data', {}).get('message', '')

                if code == 0:
                    # Login successful! Extract session cookies
                    redirect_url = body.get('data', {}).get('url', '')
                    cookies = {}
                    if redirect_url:
                        parsed = parse_qs(urlparse(redirect_url).query)
                        for k, v in parsed.items():
                            cookies[k] = v[0] if v else ""
                    return {
                        'status': 'confirmed',
                        'code': 0,
                        'message': 'Login successful!',
                        'cookies': cookies
                    }
                elif code == 86101:
                    return {'status': 'waiting_scan', 'code': code, 'message': 'Scan QR code with Bilibili App'}
                elif code == 86090:
                    return {'status': 'scanned', 'code': code, 'message': 'Scanned! Please confirm on your phone'}
                elif code == 86038:
                    return {'status': 'expired', 'code': code, 'message': 'QR code expired. Please refresh'}

        return {'status': 'error', 'message': 'Poll request failed'}

    def get_supported_resolutions(self) -> List[Dict[str, Any]]:
        return [
            {'quality': 127, 'label': '8K Ultra HD', 'resolution': '4320p', 'requiresVip': True},
            {'quality': 120, 'label': '4K Ultra HD', 'resolution': '2160p', 'requiresVip': True},
            {'quality': 116, 'label': '1080p 60fps', 'resolution': '1080p60', 'requiresVip': True},
            {'quality': 80, 'label': '1080p High Quality', 'resolution': '1080p', 'requiresVip': False},
            {'quality': 64, 'label': '720p HD', 'resolution': '720p', 'requiresVip': False},
            {'quality': 32, 'label': '480p Clear', 'resolution': '480p', 'requiresVip': False},
            {'quality': 16, 'label': '360p Fast', 'resolution': '360p', 'requiresVip': False}
        ]
