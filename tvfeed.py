"""TradingView access: screener snapshot (HTTP) and daily candle history (websocket).

Both are the public, unauthenticated endpoints the tradingview.com site itself uses.
They are free but unofficial and delayed: fine for a personal tool, not for
redistribution. Standard library only -- the websocket client below is a minimal
RFC 6455 implementation, just enough for TradingView's chart feed.
"""
import base64
import json
import os
import random
import socket
import ssl
import string
import struct
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
SCAN_URL = "https://scanner.tradingview.com/egypt/scan"
WS_HOST = "data.tradingview.com"
WS_PATH = "/socket.io/websocket?from=chart%2F&type=chart"


def scan(columns, tickers=None):
    """Screener rows as dicts. Without tickers: the whole Egypt market list."""
    payload = {"columns": columns, "range": [0, 2000]}
    if tickers:
        payload["symbols"] = {"tickers": list(tickers)}
    else:
        payload["markets"] = ["egypt"]
    req = urllib.request.Request(
        SCAN_URL, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        rows = json.load(r)["data"]
    return [dict(zip(columns, row["d"]), symbol=row["s"]) for row in rows]


class _WebSocket:
    def __init__(self, host, path, headers, timeout=30):
        raw = socket.create_connection((host, 443), timeout=timeout)
        self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
        key = base64.b64encode(os.urandom(16)).decode()
        lines = [f"GET {path} HTTP/1.1", f"Host: {host}", "Upgrade: websocket",
                 "Connection: Upgrade", f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13"]
        lines += [f"{k}: {v}" for k, v in headers.items()]
        self.sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("websocket handshake closed")
            buf += chunk
        head, self.buf = buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise ConnectionError(f"websocket handshake refused: {head[:200]!r}")

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("websocket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send_frame(self, opcode, payload):
        header = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        mask = os.urandom(4)
        header += mask
        self.sock.sendall(bytes(header) + bytes(b ^ mask[i & 3] for i, b in enumerate(payload)))

    def send(self, text):
        self._send_frame(0x1, text.encode())

    def recv(self):
        message = b""
        while True:
            b1, b2 = self._read(2)
            opcode, n = b1 & 0x0F, b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            if b2 & 0x80:
                self._read(4)  # servers don't mask, but tolerate it
            data = self._read(n)
            if opcode == 0x8:
                raise ConnectionError("websocket closed by server")
            if opcode == 0x9:
                self._send_frame(0xA, data)
                continue
            if opcode == 0xA:
                continue
            message += data
            if b1 & 0x80:
                return message.decode("utf-8", "replace")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def _pack(method, params):
    body = json.dumps({"m": method, "p": params}, separators=(",", ":"))
    return f"~m~{len(body)}~m~{body}"


def _unpack(raw):
    parts, i = [], 0
    while raw.startswith("~m~", i):
        j = raw.index("~m~", i + 3)
        n = int(raw[i + 3:j])
        parts.append(raw[j + 3:j + 3 + n])
        i = j + 3 + n
    return parts


def fetch_history(symbols, bars=1300, inflight=12, retries=2, on_progress=None):
    """Daily bars for each symbol, e.g. "EGX:COMI".

    Returns (history, errors): history maps symbol -> [[unix_ts, o, h, l, c, v], ...]
    oldest first; errors maps symbol -> message. Several chart sessions run
    concurrently over one connection; a dropped connection is reopened and the
    in-flight symbols are retried.
    """
    todo = list(dict.fromkeys(symbols))
    total = len(todo)
    attempts = {s: 0 for s in todo}
    history, errors = {}, {}

    while todo:
        try:
            ws = _WebSocket(WS_HOST, WS_PATH, {"Origin": "https://www.tradingview.com", "User-Agent": UA})
        except OSError as e:
            for s in todo:
                errors[s] = f"connect failed: {e}"
            break
        active = {}

        def start(sym):
            cs = "cs_" + "".join(random.choices(string.ascii_lowercase, k=12))
            active[cs] = {"sym": sym, "bars": []}
            attempts[sym] += 1
            ws.send(_pack("chart_create_session", [cs, ""]))
            ws.send(_pack("resolve_symbol", [cs, "sds_sym_1", "=" + json.dumps({"adjustment": "splits", "symbol": sym})]))
            ws.send(_pack("create_series", [cs, "sds_1", "s1", "sds_sym_1", "1D", bars, ""]))

        def finish(cs, error=None):
            st = active.pop(cs)
            ws.send(_pack("chart_delete_session", [cs]))
            if error:
                errors[st["sym"]] = error
            else:
                history[st["sym"]] = st["bars"]
            if on_progress:
                on_progress(len(history) + len(errors), total)
            if todo:
                start(todo.pop(0))

        try:
            ws.send(_pack("set_auth_token", ["unauthorized_user_token"]))
            for _ in range(min(inflight, len(todo))):
                start(todo.pop(0))
            while active:
                for part in _unpack(ws.recv()):
                    if part.startswith("~h~"):  # heartbeat: echo it back
                        ws.send(f"~m~{len(part)}~m~{part}")
                        continue
                    try:
                        msg = json.loads(part)
                    except ValueError:
                        continue
                    params = msg.get("p") or []
                    if not params or params[0] not in active:
                        continue
                    cs, method = params[0], msg.get("m")
                    if method == "timescale_update":
                        series = params[1].get("sds_1", {}).get("s", [])
                        active[cs]["bars"] = [x["v"][:6] for x in series]
                    elif method == "series_completed":
                        finish(cs)
                    elif method in ("symbol_error", "series_error", "critical_error"):
                        finish(cs, f"{method}: {params[1:]}")
        except (OSError, ConnectionError, ValueError) as e:
            for st in active.values():
                sym = st["sym"]
                if attempts[sym] <= retries:
                    todo.append(sym)
                else:
                    errors[sym] = f"connection error: {e}"
        finally:
            ws.close()

    return history, errors
