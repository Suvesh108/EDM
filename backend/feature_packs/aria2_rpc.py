from typing import Dict, Any, List, Optional
import os
import uuid

class Aria2RpcService:
    """
    Aria2 JSON-RPC Protocol Emulator (Port 6800).
    Allows external browser extensions (Aria2 Explorer, Camfrog, YAAW, etc.)
    to forward downloads into Vortex Downloader automatically.
    """
    def __init__(self, secret_token: str = ""):
        self.secret_token = secret_token
        self.tasks: Dict[str, Dict[str, Any]] = {}

    def handle_request(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        req_id = payload.get("id", str(uuid.uuid4()))
        method = payload.get("method", "")
        params = payload.get("params", [])

        # Validate secret token if configured
        if self.secret_token:
            if not params or not str(params[0]).startswith("token:"):
                return {"id": req_id, "jsonrpc": "2.0", "error": {"code": 1, "message": "Unauthorized: secret token required"}}
            token = str(params[0]).split("token:", 1)[1]
            if token != self.secret_token:
                return {"id": req_id, "jsonrpc": "2.0", "error": {"code": 1, "message": "Unauthorized: invalid secret token"}}
            params = params[1:]

        if method == "aria2.addUri":
            uris = params[0] if params and isinstance(params[0], list) else []
            options = params[1] if len(params) > 1 and isinstance(params[1], dict) else {}
            gid = uuid.uuid4().hex[:16]
            self.tasks[gid] = {
                "gid": gid,
                "uris": uris,
                "options": options,
                "status": "active"
            }
            return {"id": req_id, "jsonrpc": "2.0", "result": gid}

        elif method == "aria2.tellStatus":
            gid = params[0] if params else ""
            task = self.tasks.get(gid)
            if not task:
                return {"id": req_id, "jsonrpc": "2.0", "error": {"code": 1, "message": f"GID {gid} not found"}}
            return {
                "id": req_id,
                "jsonrpc": "2.0",
                "result": {
                    "gid": gid,
                    "status": task.get("status", "active"),
                    "totalLength": "0",
                    "completedLength": "0",
                    "downloadSpeed": "0"
                }
            }

        elif method == "aria2.getVersion":
            return {
                "id": req_id,
                "jsonrpc": "2.0",
                "result": {
                    "enabledFeatures": ["BitTorrent", "GZip", "HTTPS", "MessageDigest"],
                    "version": "1.37.0-vortex"
                }
            }

        return {
            "id": req_id,
            "jsonrpc": "2.0",
            "error": {"code": -32601, "message": f"Method {method} not supported"}
        }
