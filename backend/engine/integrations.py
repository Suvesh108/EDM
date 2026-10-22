"""
System Integration & Protocol Association Manager for Vortex Downloader.
Handles Windows Registry protocol handlers and file extension associations.
"""

import os
import sys
from typing import Dict, Any, Optional

try:
    import winreg
except ImportError:
    winreg = None

from database import get_setting, set_setting

if getattr(sys, 'frozen', False):
    LAUNCH_CMD = f'"{sys.executable}" "%1"'
else:
    RUN_PY_PATH = os.path.abspath(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "run.py"))
    PYTHON_EXE = sys.executable
    LAUNCH_CMD = f'"{PYTHON_EXE}" "{RUN_PY_PATH}" "%1"'

def _register_protocol_win(protocol: str, name: str) -> bool:
    if not winreg or sys.platform != "win32":
        return False
    try:
        base_path = rf"Software\Classes\{protocol}"
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base_path) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, f"URL:{name}")
            winreg.SetValueEx(key, "URL Protocol", 0, winreg.REG_SZ, "")
            
        cmd_path = rf"{base_path}\shell\open\command"
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, cmd_path) as cmd_key:
            winreg.SetValueEx(cmd_key, "", 0, winreg.REG_SZ, LAUNCH_CMD)
        return True
    except Exception:
        return False

def _unregister_protocol_win(protocol: str) -> bool:
    if not winreg or sys.platform != "win32":
        return False
    try:
        def delete_subkeys(key, path):
            try:
                with winreg.OpenKey(key, path, 0, winreg.KEY_ALL_ACCESS) as open_k:
                    while True:
                        try:
                            subkey = winreg.EnumKey(open_k, 0)
                            delete_subkeys(key, f"{path}\\{subkey}")
                        except OSError:
                            break
                winreg.DeleteKey(key, path)
            except FileNotFoundError:
                pass

        delete_subkeys(winreg.HKEY_CURRENT_USER, rf"Software\Classes\{protocol}")
        return True
    except Exception:
        return False

def _register_file_ext_win(ext: str, prog_id: str, desc: str) -> bool:
    if not winreg or sys.platform != "win32":
        return False
    try:
        ext = '.' + ext.lstrip('.')
        # 1. Map extension to ProgID
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"Software\Classes\{ext}") as ext_key:
            winreg.SetValueEx(ext_key, "", 0, winreg.REG_SZ, prog_id)
            
        # 2. Define ProgID shell command
        prog_path = rf"Software\Classes\{prog_id}"
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, prog_path) as prog_key:
            winreg.SetValueEx(prog_key, "", 0, winreg.REG_SZ, desc)
            
        cmd_path = rf"{prog_path}\shell\open\command"
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, cmd_path) as cmd_key:
            winreg.SetValueEx(cmd_key, "", 0, winreg.REG_SZ, LAUNCH_CMD)
        return True
    except Exception:
        return False

def _unregister_file_ext_win(ext: str, prog_id: str) -> bool:
    if not winreg or sys.platform != "win32":
        return False
    try:
        ext = '.' + ext.lstrip('.')
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, rf"Software\Classes\{ext}")
        except Exception:
            pass
        return True
    except Exception:
        return False

def toggle_integration(feature: str, enable: bool) -> bool:
    """Toggles and persists integration state for protocols and extensions."""
    setting_key = f"{feature}_enabled" if not feature.endswith("_enabled") else feature
    set_setting(setting_key, "true" if enable else "false")
    
    if sys.platform != "win32":
        return True

    if feature in ("protocol_vortex", "protocol_vortex_enabled"):
        return _register_protocol_win("vortex", "Vortex Downloader Protocol") if enable else _unregister_protocol_win("vortex")
    elif feature in ("assoc_magnet", "assoc_magnet_enabled"):
        return _register_protocol_win("magnet", "Magnet URI Scheme") if enable else _unregister_protocol_win("magnet")
    elif feature in ("assoc_ed2k", "assoc_ed2k_enabled"):
        return _register_protocol_win("ed2k", "eDonkey2000 Protocol") if enable else _unregister_protocol_win("ed2k")
    elif feature in ("assoc_ftp", "assoc_ftp_enabled"):
        ok1 = _register_protocol_win("ftp", "FTP Protocol") if enable else _unregister_protocol_win("ftp")
        ok2 = _register_protocol_win("ftps", "FTPS Secure Protocol") if enable else _unregister_protocol_win("ftps")
        return ok1 and ok2
    elif feature in ("assoc_torrent", "assoc_torrent_enabled"):
        return _register_file_ext_win(".torrent", "Vortex.Torrent", "BitTorrent Metafile") if enable else _unregister_file_ext_win(".torrent", "Vortex.Torrent")
    elif feature in ("assoc_hls", "assoc_hls_enabled"):
        res = True
        for ext in [".m3u8", ".m3u", ".mpd"]:
            r = _register_file_ext_win(ext, f"Vortex{ext.replace('.', '').upper()}", f"HLS Stream Playlist {ext}") if enable else _unregister_file_ext_win(ext, f"Vortex{ext.replace('.', '').upper()}")
            res = res and r
        return res
    return True

def sync_all_integrations():
    """Synchronizes all configured integrations on server startup."""
    features = [
        "protocol_vortex_enabled",
        "assoc_torrent_enabled",
        "assoc_magnet_enabled",
        "assoc_ed2k_enabled",
        "assoc_ftp_enabled",
        "assoc_hls_enabled"
    ]
    for feat in features:
        val = get_setting(feat, "false").lower() in ("true", "1")
        if val:
            toggle_integration(feat, True)
