import os
import sys
import threading
import time
import webbrowser

# Ensure backend directory is in python search path
if getattr(sys, 'frozen', False):
    root_dir = sys._MEIPASS
    backend_dir = os.path.join(root_dir, 'backend') if os.path.exists(os.path.join(root_dir, 'backend')) else root_dir
else:
    root_dir = os.path.dirname(os.path.abspath(__file__))
    backend_dir = os.path.join(root_dir, 'backend')

if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)
if root_dir not in sys.path:
    sys.path.insert(0, root_dir)

if __name__ == "__main__":
    from app import app
    import uvicorn
    port = int(os.getenv("PORT", "5001"))

    # Single-instance dispatch: forward URL arguments to active Vortex server if already running
    if len(sys.argv) > 1 and not sys.argv[1].startswith("-"):
        arg_url = sys.argv[1].strip()
        if arg_url.startswith("vortex://"):
            arg_url = arg_url.replace("vortex://download?url=", "").replace("vortex://", "")
            
        try:
            import requests
            res = requests.post(f"http://127.0.0.1:{port}/api/tasks/create", data={'url': arg_url}, timeout=2)
            if res.status_code == 200:
                print(f">> Forwarded URL to running Vortex instance: {arg_url}")
                sys.exit(0)
        except Exception:
            pass

    # Automatically launch user browser on desktop startup
    def launch_browser():
        time.sleep(1.2)
        try:
            webbrowser.open(f"http://localhost:{port}")
        except Exception:
            pass

    threading.Thread(target=launch_browser, daemon=True).start()

    print("=" * 65)
    print(f">> VortexDownloader Universal Engine v0.6.9")
    print(f">> Running on: http://localhost:{port}")
    print(f">> Aria2 JSON-RPC 2.0: http://localhost:{port}/jsonrpc")
    print("=" * 65)
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
