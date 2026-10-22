"""Local web server for the site: static files from web/ plus a refresh endpoint.

    python server.py                # http://127.0.0.1:8200, opens your browser
    python server.py --port 9000 --no-browser
    python server.py --refresh      # rebuild the data on start

The first start builds the data automatically (about a minute). Afterwards the
site's Refresh button rebuilds it in the background while you keep browsing.
"""
import argparse
import http.server
import json
import os
import threading
import time
import traceback
import webbrowser

import egx_data

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

_lock = threading.Lock()
_status = {"running": False, "phase": "", "done": 0, "total": 0, "error": None, "finished": None}


def snapshot():
    with _lock:
        return dict(_status)


def _run_build():
    def progress(phase, done=0, total=0):
        with _lock:
            _status.update(phase=phase, done=done, total=total)

    try:
        egx_data.build(progress)
        with _lock:
            _status.update(error=None, finished=time.time())
    except Exception as e:  # report any failure to the page instead of dying silently
        traceback.print_exc()
        with _lock:
            _status["error"] = f"{type(e).__name__}: {e}"
    finally:
        with _lock:
            _status["running"] = False


def start_build():
    with _lock:
        if _status["running"]:
            return False
        _status.update(running=True, phase="Starting", done=0, total=0, error=None)
    threading.Thread(target=_run_build, daemon=True).start()
    return True


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".json": "application/json", ".css": "text/css",
        ".svg": "image/svg+xml", ".html": "text/html",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def end_headers(self):
        if self.path.startswith("/data/") or self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/status":
            return self._json(snapshot())
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/refresh":
            return self.send_error(404)
        # A custom header can't be sent cross-site without a preflight, so other pages can't trigger this.
        if self.headers.get("X-Requested-By") != "above-the-line":
            return self.send_error(403)
        started = start_build()
        return self._json({"started": started, **snapshot()})

    def log_message(self, fmt, *args):
        pass


def main():
    ap = argparse.ArgumentParser(description="Serve the EGX moving-average site locally.")
    ap.add_argument("--port", type=int, default=8200)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--refresh", action="store_true", help="rebuild the data on start")
    args = ap.parse_args()

    if args.refresh or not os.path.exists(egx_data.MARKET_FILE):
        start_build()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Above the Line is running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
