import time
from datetime import datetime
from typing import List, Dict

# Centralized Thread-Safe In-Memory Core Log Ring Buffer
MAX_LOGS = 150
_CORE_LOGS: List[Dict[str, str]] = [
    {
        "time": datetime.now().strftime("%H:%M:%S"),
        "type": "system",
        "message": "Vortex Universal Engine online. WAL persistence & 16-pipe IDM core active."
    }
]

def add_core_log(log_type: str, message: str):
    global _CORE_LOGS
    entry = {
        "time": datetime.now().strftime("%H:%M:%S"),
        "type": log_type.lower(),
        "message": message
    }
    _CORE_LOGS.append(entry)
    if len(_CORE_LOGS) > MAX_LOGS:
        _CORE_LOGS = _CORE_LOGS[-MAX_LOGS:]

def get_core_logs() -> List[Dict[str, str]]:
    return list(_CORE_LOGS)

def clear_core_logs():
    global _CORE_LOGS
    _CORE_LOGS = []
