import sys
import logging

logger = logging.getLogger("vortex.keepalive")

_held = False
_active_count = 0

def hold() -> bool:
    """Inhibit system sleep while downloads are active."""
    global _held, _active_count
    _active_count += 1
    if _held:
        return True

    try:
        if sys.platform == "win32":
            import ctypes
            ES_CONTINUOUS = 0x80000000
            ES_SYSTEM_REQUIRED = 0x00000001
            ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
            _held = True
            logger.info("System sleep inhibited (Windows SetThreadExecutionState)")
            return True
        elif sys.platform == "darwin":
            import ctypes
            import ctypes.util
            iokit = ctypes.cdll.LoadLibrary(ctypes.util.find_library("IOKit"))
            cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))
            # IOPMAssertionCreateWithName
            _held = True
            logger.info("System sleep inhibited (macOS IOKit)")
            return True
    except Exception as e:
        logger.warning(f"Failed to inhibit system sleep: {e}")
    return False

def release() -> bool:
    """Release system sleep inhibit when all downloads are complete."""
    global _held, _active_count
    if _active_count > 0:
        _active_count -= 1
    if _active_count > 0 or not _held:
        return True

    try:
        if sys.platform == "win32":
            import ctypes
            ES_CONTINUOUS = 0x80000000
            ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)
            _held = False
            logger.info("System sleep released (Windows SetThreadExecutionState)")
            return True
        elif sys.platform == "darwin":
            _held = False
            return True
    except Exception as e:
        logger.warning(f"Failed to release system sleep inhibit: {e}")
    return False
