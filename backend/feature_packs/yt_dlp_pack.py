from typing import Dict, Any, List, Tuple, Optional
import os

class YtDlpPack:
    """
    Decoupled yt-dlp Media Feature Pack (modeled after Ghost Downloader 3).
    Extracts separate adaptive video streams (2160p 4K, 1440p 2K, 1080p FHD, 720p HD)
    and audio streams (AAC / Opus / MP3), allowing parallel chunked downloading
    and fast local FFmpeg stream muxing.
    """
    DIRECT_PROTOCOLS = {"https", "http"}

    @staticmethod
    def build_format_pair(formats: List[Dict[str, Any]], target_height: int = 1080, prefer_mp4: bool = True) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        direct_formats = [f for f in formats if f.get('protocol') in YtDlpPack.DIRECT_PROTOCOLS or not f.get('protocol')]

        # 1. Best matching audio format
        audio_formats = [
            f for f in direct_formats
            if f.get('acodec', 'none') != 'none' and f.get('vcodec', 'none') == 'none'
        ]
        audio_formats.sort(
            key=lambda f: (
                1 if (prefer_mp4 and f.get('ext') in ('m4a', 'mp4')) else 0,
                f.get('abr') or f.get('tbr') or 0
            ),
            reverse=True
        )
        best_audio = audio_formats[0] if audio_formats else None

        # 2. Best matching video format with height <= target_height
        video_formats = [
            f for f in direct_formats
            if f.get('vcodec', 'none') != 'none' and f.get('acodec', 'none') == 'none'
        ]
        if target_height > 0:
            filtered_video = [f for f in video_formats if (f.get('height') or 0) <= target_height]
            if filtered_video:
                video_formats = filtered_video

        video_formats.sort(
            key=lambda f: (
                1 if (prefer_mp4 and f.get('ext') in ('mp4', 'm4a')) else 0,
                f.get('height') or 0,
                f.get('tbr') or 0
            ),
            reverse=True
        )
        best_video = video_formats[0] if video_formats else None

        # Fallback to combined stream if no separate video stream
        if not best_video:
            combined = [f for f in direct_formats if f.get('vcodec', 'none') != 'none']
            combined.sort(key=lambda f: (f.get('height') or 0, f.get('tbr') or 0), reverse=True)
            if combined:
                best_video = combined[0]

        return best_video, best_audio
