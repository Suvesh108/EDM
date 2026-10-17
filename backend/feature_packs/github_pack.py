import re
import httpx
from urllib.parse import urlparse
from typing import Dict, Any, Optional, List

GITHUB_HOSTS = {
    "api.github.com",
    "codeload.github.com",
    "gist.github.com",
    "gist.githubusercontent.com",
    "github-releases.githubusercontent.com",
    "media.githubusercontent.com",
    "objects.githubusercontent.com",
    "raw.githubusercontent.com",
    "raw.github.com",
    "release-assets.githubusercontent.com",
}

class GitHubPack:
    def parse_url(self, raw_url: str) -> Dict[str, Any]:
        parsed = urlparse(raw_url.strip())
        hostname = (parsed.hostname or '').lower().removeprefix("www.")

        if hostname not in GITHUB_HOSTS and hostname != 'github.com':
            return {'isGitHub': False}

        path = parsed.path.strip('/')
        parts = path.split('/')

        # Direct raw/asset download URLs from CDN hosts
        if hostname in GITHUB_HOSTS:
            owner = parts[0] if len(parts) > 0 else 'github'
            repo = parts[1] if len(parts) > 1 else 'asset'
            return {
                'isGitHub': True,
                'type': 'raw',
                'owner': owner,
                'repo': repo,
                'directUrl': raw_url
            }

        if len(parts) < 2:
            return {'isGitHub': False}

        owner = parts[0]
        repo = parts[1]

        # Raw file / blob link on github.com
        if len(parts) >= 4 and parts[2] in ('raw', 'releases'):
            if parts[2] == 'raw':
                return {
                    'isGitHub': True,
                    'type': 'raw',
                    'owner': owner,
                    'repo': repo,
                    'directUrl': raw_url
                }
            if parts[3] == 'tag' and len(parts) >= 5:
                return {
                    'isGitHub': True,
                    'type': 'release-tag',
                    'owner': owner,
                    'repo': repo,
                    'tag': parts[4]
                }
            if parts[3] == 'download' and len(parts) >= 6:
                return {
                    'isGitHub': True,
                    'type': 'release-direct',
                    'owner': owner,
                    'repo': repo,
                    'directUrl': raw_url
                }
            if parts[3] == 'latest' and len(parts) >= 6 and parts[4] == 'download':
                return {
                    'isGitHub': True,
                    'type': 'release-direct',
                    'owner': owner,
                    'repo': repo,
                    'directUrl': raw_url
                }

        # Archive tarball / zipball
        if len(parts) >= 3 and parts[2] == 'archive':
            return {
                'isGitHub': True,
                'type': 'archive',
                'owner': owner,
                'repo': repo,
                'directUrl': raw_url
            }

        return {
            'isGitHub': True,
            'type': 'repo',
            'owner': owner,
            'repo': repo
        }

    async def inspect_release(self, owner: str, repo: str, tag: Optional[str] = None) -> Dict[str, Any]:
        url = (
            f"https://api.github.com/repos/{owner}/{repo}/releases/tags/{tag}"
            if tag
            else f"https://api.github.com/repos/{owner}/{repo}/releases/latest"
        )

        headers = {
            'User-Agent': 'VortexDownloader/0.6.8',
            'Accept': 'application/vnd.github.v3+json'
        }

        async with httpx.AsyncClient(timeout=12.0, follow_redirects=True) as client:
            res = await client.get(url, headers=headers)
            if res.status_code != 200:
                raise Exception(f"GitHub API error: HTTP {res.status_code}")
            data = res.json()

            assets = []
            for a in data.get('assets', []):
                assets.append({
                    'name': a.get('name'),
                    'size': a.get('size'),
                    'downloadUrl': a.get('browser_download_url'),
                    'downloadCount': a.get('download_count', 0),
                    'contentType': a.get('content_type')
                })

            return {
                'tag': data.get('tag_name'),
                'name': data.get('name') or data.get('tag_name'),
                'publishedAt': data.get('published_at'),
                'tarballUrl': data.get('tarball_url'),
                'zipballUrl': data.get('zipball_url'),
                'assets': assets
            }

    MIRRORS = [
        "https://ghproxy.net/",
        "https://mirror.ghproxy.com/",
        "https://gh-proxy.com/",
        "https://hub.gitmirror.com/"
    ]

    def get_accelerated_urls(self, raw_url: str) -> List[Dict[str, str]]:
        """Return direct URL along with high-speed CDN acceleration mirrors."""
        res = [{'label': 'Direct (GitHub Global CDN)', 'url': raw_url}]
        for m in self.MIRRORS:
            res.append({
                'label': f"Turbo Mirror ({urlparse(m).hostname})",
                'url': f"{m}{raw_url}"
            })
        return res
