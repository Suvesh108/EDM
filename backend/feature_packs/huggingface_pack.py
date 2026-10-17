import re
import httpx
from urllib.parse import urlparse
from typing import Dict, Any, Optional, List

REPO_PATTERN = re.compile(
    r"^/(?P<type>datasets/|spaces/)?(?P<org>[\w.-]+)(?:/(?P<repo>[\w.-]+))?"
    r"(?:/(?P<kind>resolve|raw|tree|blob)/(?P<rev>[\w.-]+)(?:/(?P<path>.*))?)?/?$"
)

class HuggingFacePack:
    def parse_url(self, raw_url: str) -> Dict[str, Any]:
        parsed = urlparse(raw_url.strip())
        hostname = (parsed.hostname or '').lower()

        if hostname != 'huggingface.co' and hostname != 'hf.co':
            return {'isHuggingFace': False}

        m = REPO_PATTERN.match(parsed.path)
        if not m:
            return {'isHuggingFace': False}

        type_prefix = m.group('type') or ''
        repo_type = 'dataset' if type_prefix.startswith('datasets') else ('space' if type_prefix.startswith('spaces') else 'model')
        org = m.group('org')
        repo = m.group('repo')
        rev = m.group('rev') or 'main'
        file_path = m.group('path') or ''
        kind = m.group('kind') or ''

        # If repo is None, org is actually the root model ID (e.g. 'bert-base-uncased', 'gpt2')
        if repo:
            model_id = f"{org}/{repo}"
        else:
            model_id = org

        # Direct file URL
        if file_path and kind in ('resolve', 'raw'):
            return {
                'isHuggingFace': True,
                'isDirectFile': True,
                'modelId': model_id,
                'repoType': repo_type,
                'revision': rev,
                'filePath': file_path,
                'directUrl': raw_url
            }

        return {
            'isHuggingFace': True,
            'isDirectFile': False,
            'modelId': model_id,
            'repoType': repo_type,
            'revision': rev,
            'filePath': file_path
        }

    async def inspect_model(self, model_id: str, revision: str = 'main', repo_type: str = 'model') -> Dict[str, Any]:
        api_prefix = "datasets" if repo_type == "dataset" else ("spaces" if repo_type == "space" else "models")
        api_url = f"https://huggingface.co/api/{api_prefix}/{model_id}"
        headers = {'User-Agent': 'VortexDownloader/0.6.8'}

        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            res = await client.get(api_url, headers=headers)
            if res.status_code != 200:
                raise Exception(f"Hugging Face API error: HTTP {res.status_code}")
            data = res.json()

            siblings: List[Dict[str, Any]] = []
            # Check siblings in metadata
            for s in data.get('siblings', []):
                fn = s.get('rfilename')
                if fn:
                    url_prefix = f"{repo_type}s/" if repo_type in ("dataset", "space") else ""
                    siblings.append({
                        'rfilename': fn,
                        'downloadUrl': f"https://huggingface.co/{url_prefix}{model_id}/resolve/{revision}/{fn}"
                    })

            # If no siblings returned, try tree API
            if not siblings:
                tree_url = f"https://huggingface.co/api/{api_prefix}/{model_id}/tree/{revision}"
                tree_res = await client.get(tree_url, headers=headers)
                if tree_res.status_code == 200:
                    tree_data = tree_res.json()
                    if isinstance(tree_data, list):
                        url_prefix = f"{repo_type}s/" if repo_type in ("dataset", "space") else ""
                        for item in tree_data:
                            if item.get('type') == 'file':
                                path = item.get('path', '')
                                siblings.append({
                                    'rfilename': path,
                                    'size': item.get('size', 0),
                                    'downloadUrl': f"https://huggingface.co/{url_prefix}{model_id}/resolve/{revision}/{path}"
                                })

            return {
                'id': data.get('id', model_id),
                'author': data.get('author'),
                'downloads': data.get('downloads', 0),
                'likes': data.get('likes', 0),
                'pipeline_tag': data.get('pipeline_tag'),
                'repoType': repo_type,
                'revision': revision,
                'files': siblings
            }
