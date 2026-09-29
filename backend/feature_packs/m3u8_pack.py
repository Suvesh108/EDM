import re
import os
from typing import Dict, Any, List
from urllib.parse import urljoin, urlparse

class M3u8Pack:
    """
    HLS / m3u8 Adaptive Stream Feature Pack.
    Parses master & media playlists, detects AES-128 / SAMPLE-AES encryption,
    and extracts all sub-stream variants (resolutions, bitrates, audio tracks).
    """
    BANDWIDTH_PATTERN = re.compile(r"BANDWIDTH=(\d+)")
    RESOLUTION_PATTERN = re.compile(r"RESOLUTION=(\d+x\d+)")
    KEY_PATTERN = re.compile(r"#EXT-X-KEY:METHOD=([^,]+)(?:,URI=\"([^\"]+)\")?")

    def is_m3u8(self, url: str) -> bool:
        path = urlparse(url).path.lower()
        return path.endswith('.m3u8') or 'm3u8' in url.lower()

    def parse_manifest(self, content: str, base_url: str) -> Dict[str, Any]:
        lines = [line.strip() for line in content.splitlines() if line.strip()]
        if not lines or not lines[0].startswith('#EXTM3U'):
            return {'isValid': False, 'error': 'Invalid HLS playlist: missing #EXTM3U header.'}

        variants: List[Dict[str, Any]] = []
        segments: List[str] = []
        keys: List[Dict[str, str]] = []
        is_master = False
        target_duration = 0

        i = 0
        while i < len(lines):
            line = lines[i]
            if line.startswith('#EXT-X-STREAM-INF:'):
                is_master = True
                bw_match = self.BANDWIDTH_PATTERN.search(line)
                res_match = self.RESOLUTION_PATTERN.search(line)
                bw = int(bw_match.group(1)) if bw_match else 0
                res = res_match.group(1) if res_match else "Adaptive"

                stream_url = ""
                if i + 1 < len(lines) and not lines[i + 1].startswith('#'):
                    stream_url = urljoin(base_url, lines[i + 1])
                    i += 1

                variants.append({
                    'resolution': res,
                    'bandwidth': bw,
                    'bitrate': f"{bw // 1000} kbps" if bw else "Auto",
                    'url': stream_url
                })
            elif line.startswith('#EXT-X-KEY:'):
                key_match = self.KEY_PATTERN.search(line)
                if key_match:
                    method = key_match.group(1)
                    key_uri = urljoin(base_url, key_match.group(2)) if key_match.group(2) else ""
                    keys.append({'method': method, 'uri': key_uri})
            elif line.startswith('#EXT-X-TARGETDURATION:'):
                try:
                    target_duration = int(line.split(':')[1])
                except Exception:
                    pass
            elif not line.startswith('#'):
                segments.append(urljoin(base_url, line))
            i += 1

        return {
            'isValid': True,
            'isMaster': is_master,
            'variantCount': len(variants),
            'variants': sorted(variants, key=lambda x: x.get('bandwidth', 0), reverse=True),
            'segmentCount': len(segments),
            'targetDuration': target_duration,
            'isEncrypted': len(keys) > 0,
            'encryptionKeys': keys
        }
