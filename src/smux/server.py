"""aiohttp HTTP + WebSocket server bridging PTYs to the browser frontend."""
from __future__ import annotations

import asyncio
import base64
import json
import subprocess
import sys
import uuid
from pathlib import Path

_STATE_FILE = Path.home() / ".smux" / "state.json"
_HOSTS_FILE = Path.home() / ".smux" / "hosts.json"

import aiohttp
from aiohttp import web

from .pty_manager import PtyManager, _get_proc_cwd

if getattr(sys, 'frozen', False):
    _STATIC = Path(sys._MEIPASS) / "static"  # type: ignore[attr-defined]
else:
    _STATIC = Path(__file__).parent / "static"


class SmuxServer:
    def __init__(self) -> None:
        self.mgr = PtyManager()
        self.mgr.on_output = self._on_output
        self.mgr.on_closed = self._on_pty_closed
        self._clients: set[web.WebSocketResponse] = set()

    # ── Broadcast helpers ──────────────────────────────────────────

    async def _broadcast(self, msg: dict) -> None:
        text = json.dumps(msg)
        dead: set[web.WebSocketResponse] = set()
        for ws in list(self._clients):
            try:
                await ws.send_str(text)
            except Exception:
                dead.add(ws)
        self._clients -= dead

    async def _on_output(self, window_id: str, data: bytes) -> None:
        await self._broadcast({
            "type": "output",
            "windowId": window_id,
            "data": base64.b64encode(data).decode(),
        })

    async def _on_pty_closed(self, window_id: str) -> None:
        self.mgr.close_window(window_id)
        await self._broadcast({"type": "window_closed", "windowId": window_id})
        self._save_state()

    # ── Persistent state ───────────────────────────────────────────

    def _save_state(self) -> None:
        try:
            _STATE_FILE.parent.mkdir(exist_ok=True)
            data = {
                "version": 1,
                "groups": [
                    {"id": g.id, "name": g.name, "color": g.color, "collapsed": g.collapsed}
                    for g in self.mgr.groups.values()
                ],
                "windows": [
                    {
                        "id": s.window.id,
                        "label": s.window.label,
                        "color": s.window.color,
                        "group_id": s.window.group_id,
                        "cwd": s.cwd,
                    }
                    for wid in self.mgr.order
                    for s in [self.mgr.windows[wid]]
                ],
            }
            _STATE_FILE.write_text(json.dumps(data, indent=2))
        except Exception:
            pass

    async def _restore_state(self) -> None:
        if not _STATE_FILE.exists():
            return
        try:
            data = json.loads(_STATE_FILE.read_text())
            for g in data.get("groups", []):
                self.mgr.new_group(
                    name=g.get("name", "Group"),
                    color=g.get("color", "#4ecdc4"),
                    group_id=g.get("id"),
                    collapsed=g.get("collapsed", False),
                )
            for w in data.get("windows", []):
                self.mgr.new_window(
                    label=w.get("label", "Terminal"),
                    color=w.get("color"),
                    group_id=w.get("group_id"),
                    window_id=w.get("id"),
                    cwd=w.get("cwd"),
                )
        except Exception:
            pass

    # ── WebSocket handler ──────────────────────────────────────────

    async def ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(max_msg_size=0)  # no size cap — chunking happens client-side
        await ws.prepare(request)
        self._clients.add(ws)

        await ws.send_str(json.dumps({"type": "state", **self.mgr.state_dict()}))

        # Replay buffered output so reconnecting clients see current terminal state
        for wid in self.mgr.order:
            state = self.mgr.windows.get(wid)
            if state and state._buf:
                await ws.send_str(json.dumps({
                    "type": "output",
                    "windowId": wid,
                    "data": base64.b64encode(bytes(state._buf)).decode(),
                }))

        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    await self._handle(json.loads(msg.data))
                elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                    break
        finally:
            self._clients.discard(ws)

        return ws

    async def _handle(self, msg: dict) -> None:
        t = msg.get("type")

        if t == "input":
            state = self.mgr.windows.get(msg["windowId"])
            if state:
                state.write(base64.b64decode(msg["data"]))

        elif t == "resize":
            state = self.mgr.windows.get(msg["windowId"])
            if state:
                state.resize(int(msg["cols"]), int(msg["rows"]))

        elif t == "new_window":
            win = self.mgr.new_window(
                label=msg.get("label", "Terminal"),
                color=msg.get("color"),
                group_id=msg.get("groupId"),
                cols=int(msg.get("cols", 120)),
                rows=int(msg.get("rows", 40)),
            )
            await self._broadcast({
                "type": "window_created",
                "window": {
                    "id": win.id,
                    "label": win.label,
                    "color": win.color,
                    "groupId": win.group_id,
                },
            })
            self._save_state()
            if msg.get("command"):
                cmd = msg["command"]
                wid = win.id
                async def _send_command(w=wid, c=cmd):
                    await asyncio.sleep(0.4)
                    state = self.mgr.windows.get(w)
                    if state:
                        state.write((c + "\n").encode())
                asyncio.ensure_future(_send_command())

        elif t == "close_window":
            wid = msg["windowId"]
            self.mgr.close_window(wid)
            await self._broadcast({"type": "window_closed", "windowId": wid})
            self._save_state()

        elif t == "rename_window":
            state = self.mgr.windows.get(msg["windowId"])
            if state:
                state.window.label = msg["label"]
                state.window.color = msg["color"]
                await self._broadcast({"type": "state", **self.mgr.state_dict()})
                self._save_state()

        elif t == "new_group":
            self.mgr.new_group(msg.get("name", "Group"), msg.get("color", "#4ecdc4"))
            await self._broadcast({"type": "state", **self.mgr.state_dict()})
            self._save_state()

        elif t == "move_to_group":
            state = self.mgr.windows.get(msg["windowId"])
            if state:
                state.window.group_id = msg.get("groupId")
                await self._broadcast({"type": "state", **self.mgr.state_dict()})
                self._save_state()

        elif t == "rename_group":
            g = self.mgr.groups.get(msg["groupId"])
            if g:
                g.name  = msg["name"]
                g.color = msg["color"]
                await self._broadcast({"type": "state", **self.mgr.state_dict()})
                self._save_state()

        elif t == "toggle_group":
            g = self.mgr.groups.get(msg["groupId"])
            if g:
                g.collapsed = not g.collapsed
                await self._broadcast({"type": "state", **self.mgr.state_dict()})
                self._save_state()

    # ── App factory ────────────────────────────────────────────────

    async def _busy_watcher(self) -> None:
        """Broadcast state whenever any window's busy status changes; also polls CWD."""
        prev: dict[str, bool] = {}
        loop = asyncio.get_running_loop()
        while True:
            await asyncio.sleep(0.5)
            # os.tcgetpgrp() and proc_pidinfo can block on a stale PTY fd (e.g.
            # a dropped SSH session).  Run everything in a thread so a hung
            # syscall cannot freeze the asyncio event loop.
            snapshot = list(self.mgr.windows.items())
            def _check() -> dict[str, bool]:
                result = {}
                for wid, s in snapshot:
                    result[wid] = s.is_busy()
                    # Poll CWD via libproc as a fallback for shells that don't
                    # emit OSC 7.  proc_pidinfo is fast and non-blocking.
                    if s.pty and s.pty.isalive():
                        cwd = _get_proc_cwd(s.pty.pid)
                        if cwd:
                            s.cwd = cwd
                return result
            curr = await loop.run_in_executor(None, _check)
            if curr != prev:
                prev = curr
                if self._clients:
                    await self._broadcast({"type": "state", **self.mgr.state_dict()})

    async def _clipboard_handler(self, request: web.Request) -> web.Response:
        """Return the current macOS clipboard contents as plain text.

        Tries pbpaste first (fast, text only).  If the clipboard holds no text
        (e.g. files copied in Finder, or a screenshot), falls back to AppleScript
        to extract POSIX file paths so they can be pasted into the terminal.

        All subprocess calls run in a thread executor — avoids asyncio's subprocess
        machinery (which conflicts with PyInstaller's SIGCHLD patching and can
        stall the event loop).
        """
        loop = asyncio.get_running_loop()

        def _read_clipboard() -> str:
            # 1. Plain text via pbpaste
            try:
                text = subprocess.run(
                    ["/usr/bin/pbpaste"],
                    capture_output=True, timeout=2,
                ).stdout.decode("utf-8", errors="replace")
                if text:
                    return text
            except Exception:
                pass

            # 2. File paths via AppleScript (files copied in Finder).
            # Uses multiple -e flags (each a single statement) which is more
            # reliable than embedding newlines in one -e argument.
            try:
                result = subprocess.run(
                    [
                        "osascript",
                        "-e", "set out to {}",
                        "-e", "try",
                        "-e", "  set fs to (the clipboard as {alias})",
                        "-e", "  repeat with f in fs",
                        "-e", "    set end of out to POSIX path of f",
                        "-e", "  end repeat",
                        "-e", "end try",
                        "-e", "set AppleScript's text item delimiters to \" \"",
                        "-e", "return out as text",
                    ],
                    capture_output=True, timeout=3,
                ).stdout.decode("utf-8", errors="replace").strip()
                return result
            except Exception:
                pass

            return ""

        text = await loop.run_in_executor(None, _read_clipboard)
        return web.Response(text=text, content_type="text/plain")

    # ── Hosts CRUD ─────────────────────────────────────────────────────

    def _load_hosts(self) -> list[dict]:
        try:
            return json.loads(_HOSTS_FILE.read_text())
        except Exception:
            return []

    def _save_hosts(self, hosts: list[dict]) -> None:
        try:
            _HOSTS_FILE.parent.mkdir(exist_ok=True)
            _HOSTS_FILE.write_text(json.dumps(hosts, indent=2))
        except Exception:
            pass

    async def _hosts_list(self, request: web.Request) -> web.Response:
        return web.json_response(self._load_hosts())

    async def _hosts_create(self, request: web.Request) -> web.Response:
        body = await request.json()
        hosts = self._load_hosts()
        host = {"id": str(uuid.uuid4()), "name": body["name"], "command": body["command"]}
        hosts.append(host)
        self._save_hosts(hosts)
        return web.json_response(host, status=201)

    async def _hosts_update(self, request: web.Request) -> web.Response:
        hid = request.match_info["id"]
        body = await request.json()
        hosts = self._load_hosts()
        for h in hosts:
            if h["id"] == hid:
                h["name"]    = body.get("name",    h["name"])
                h["command"] = body.get("command", h["command"])
                self._save_hosts(hosts)
                return web.json_response(h)
        return web.Response(status=404)

    async def _hosts_delete(self, request: web.Request) -> web.Response:
        hid = request.match_info["id"]
        hosts = [h for h in self._load_hosts() if h["id"] != hid]
        self._save_hosts(hosts)
        return web.Response(status=204)

    def make_app(self) -> web.Application:
        @web.middleware
        async def no_cache(request, handler):
            resp = await handler(request)
            resp.headers['Cache-Control'] = 'no-store'
            return resp

        app = web.Application(middlewares=[no_cache])
        app.router.add_get("/", lambda r: web.FileResponse(_STATIC / "index.html"))
        app.router.add_get("/ws", self.ws_handler)
        app.router.add_get("/clipboard", self._clipboard_handler)
        app.router.add_get("/hosts", self._hosts_list)
        app.router.add_post("/hosts", self._hosts_create)
        app.router.add_put("/hosts/{id}", self._hosts_update)
        app.router.add_delete("/hosts/{id}", self._hosts_delete)
        app.router.add_static("/static", _STATIC)
        async def _on_startup(_app):
            await self._restore_state()
            asyncio.ensure_future(self._busy_watcher())
        app.on_startup.append(_on_startup)
        return app


async def run_server(host: str = "127.0.0.1", port: int = 0) -> tuple[web.AppRunner, int]:
    """Start the server. Returns (runner, actual_port)."""
    srv = SmuxServer()
    app = srv.make_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    actual_port: int = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
    return runner, actual_port
