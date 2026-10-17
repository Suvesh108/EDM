import json
import xml.sax.saxutils as saxutils
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional

class ExportManager:
    @staticmethod
    def escape_xml(s: str) -> str:
        return saxutils.escape(s, {
            '"': "&quot;",
            "'": "&apos;"
        })

    @staticmethod
    def to_metalink(tasks: List[Dict[str, Any]]) -> str:
        files_xml_list = []
        for task in tasks:
            url = task.get('url', '')
            file_name = task.get('fileName', 'download.bin')
            size = task.get('fileSize')
            size_tag = f"    <size>{size}</size>\n" if size else ""
            files_xml_list.append(
                f'    <file name="{ExportManager.escape_xml(file_name)}">\n'
                f"{size_tag}"
                f'      <url priority="1">{ExportManager.escape_xml(url)}</url>\n'
                f'    </file>'
            )
        files_xml = "\n".join(files_xml_list)
        now_iso = datetime.now(timezone.utc).isoformat()
        return f"""<?xml version="1.0" encoding="UTF-8"?>
<metalink xmlns="urn:ietf:params:xml:ns:metalink">
  <generator>Vortex Downloader 0.6.9</generator>
  <published>{now_iso}</published>
{files_xml}
</metalink>"""

    @staticmethod
    def to_curl_script(tasks: List[Dict[str, Any]]) -> str:
        commands = []
        for task in tasks:
            url = task.get('url', '')
            file_name = task.get('fileName', 'download.bin')
            safe_name = file_name.replace('"', '\\"')
            commands.append(f'echo "Downloading {safe_name}..."\ncurl -C - -L --retry 5 --retry-delay 2 -o "{safe_name}" "{url}"')

        body = "\n\n".join(commands)
        return f"""#!/usr/bin/env bash
# ==============================================================================
# Vortex Downloader - Turbo Batch Export (cURL Script)
# Generated: {datetime.now(timezone.utc).isoformat()}
# Total Tasks: {len(tasks)}
# ==============================================================================

set -e

{body}

echo "All Vortex downloads completed successfully."
"""

    @staticmethod
    def to_aria2_input(tasks: List[Dict[str, Any]]) -> str:
        blocks = []
        for task in tasks:
            url = task.get('url', '')
            file_name = task.get('fileName', 'download.bin')
            blocks.append(f"{url}\n  out={file_name}\n  split=16\n  max-connection-per-server=16\n  continue=true")
        return "\n\n".join(blocks)

    @staticmethod
    def to_json(tasks: List[Dict[str, Any]]) -> str:
        data = {
            "version": "0.6.9",
            "generator": "Vortex Downloader",
            "exportedAt": datetime.now(timezone.utc).isoformat(),
            "totalTasks": len(tasks),
            "tasks": tasks
        }
        return json.dumps(data, indent=2)
