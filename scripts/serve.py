# -*- coding: utf-8 -*-
"""本地服务：静态页面 + 增量扩充标的池 API。

用法：python serve.py [端口]
启动后自动打开电脑版页面；手机与电脑连同一 Wi-Fi，
用提示的局域网地址即可打开手机版（可“添加到主屏幕”）。
"""

import json
import os
import socket
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import update_data

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCK = threading.Lock()
STATE = {"running": False, "phase": "", "current": 0, "total": 0, "added": 0, "error": ""}


def lan_ip():
    """取本机在局域网中的地址，取不到时退回 127.0.0.1。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("223.5.5.5", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def run_update(add, mode="add"):
    with LOCK:
        if STATE["running"]:
            return
        STATE.update({"running": True, "phase": "scan", "current": 0,
                      "total": add if mode == "add" else 0, "added": 0, "error": ""})

    def progress(phase, cur, total):
        STATE.update({"phase": phase, "current": cur, "total": total})

    try:
        if mode == "refresh":
            changed = update_data.refresh_bars(20, progress)
        else:
            changed = update_data.add_symbols(add, progress)
        STATE.update({"phase": "done", "added": changed, "running": False})
    except Exception as exc:  # noqa: BLE001
        STATE.update({"phase": "error", "error": str(exc), "running": False})


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def _json(self, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/api/update/status"):
            self._json(STATE)
            return
        if self.path in ("/", "/index.html"):
            self._redirect("/app/kline-mobile.html")
            return
        super().do_GET()

    def do_POST(self):
        if not self.path.startswith("/api/update"):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(body or b"{}")
        except Exception:  # noqa: BLE001
            payload = {}
        add = max(1, min(int(payload.get("add", 60)), 300))
        mode = "refresh" if payload.get("mode") == "refresh" else "add"

        if STATE["running"]:
            self._json({"ok": False, "error": "更新正在进行中"})
            return
        threading.Thread(target=run_update, args=(add, mode), daemon=True).start()
        self._json({"ok": True})


def main():
    import sys
    start_port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = None
    port = start_port
    for p in range(start_port, start_port + 10):
        try:
            server = ThreadingHTTPServer(("0.0.0.0", p), Handler)
            port = p
            break
        except OSError:
            continue
    if server is None:
        raise SystemExit("端口被占用，请换一个端口：python serve.py 8123")

    host = lan_ip()
    desktop = f"http://127.0.0.1:{port}/app/kline-training.html"
    mobile = f"http://{host}:{port}/app/kline-mobile.html"
    print("=" * 62)
    print("  K线训练营 已启动")
    print(f"  电脑版: {desktop}")
    print(f"  手机版: {mobile}")
    print("  手机与电脑连同一个 Wi-Fi，用手机浏览器打开上面的手机版地址；")
    print("  iOS/安卓浏览器菜单里可“添加到主屏幕”，像 App 一样使用。")
    print("  若手机打不开，请允许 Windows 防火墙的“专用网络”访问。")
    print("  保持此窗口运行，“扩充标的池”才可用；Ctrl+C 退出。")
    print("=" * 62)
    if os.environ.get("KLINE_NO_OPEN") != "1":
        threading.Timer(1.0, lambda: webbrowser.open(desktop)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
