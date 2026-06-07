"""PTY process management — no UI dependencies."""
from __future__ import annotations

import asyncio
import ctypes
import ctypes.util
import os
import re
import uuid
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional
from urllib.parse import unquote as _url_unquote

import ptyprocess

COLORS = ["#4ecdc4", "#7aa2f7", "#9ece6a", "#e0af68", "#bb9af7", "#f7768e", "#7dcfff", "#fab387"]


def _uid() -> str:
    return uuid.uuid4().hex[:8]


# ── CWD helpers ────────────────────────────────────────────────────────────────

# Matches OSC 7 working-directory notifications emitted by shells (zsh, bash, fish).
# Format: ESC ] 7 ; file://hostname/path BEL  (BEL = \x07, or ST = ESC \)
_OSC7_RE = re.compile(rb'\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)')

def _parse_osc7_cwd(data: bytes) -> Optional[str]:
    """Extract a CWD path from an OSC 7 sequence in *data*, or None."""
    m = _OSC7_RE.search(data)
    if not m:
        return None
    try:
        url = m.group(1).decode('utf-8', errors='replace')
        if url.startswith('file://'):
            rest = url[7:]          # strip "file://"
            slash = rest.find('/')  # find start of path after hostname
            path = rest[slash:] if slash >= 0 else '/'
        elif url.startswith('/'):
            path = url
        else:
            return None
        return _url_unquote(path) or None
    except Exception:
        return None


# macOS proc_pidinfo — reads the CWD of any process without spawning a subprocess.
# struct proc_vnodepathinfo layout (macOS 64-bit):
#   pvi_cdir: vnode_info_path  (1176 bytes)
#   pvi_rdir: vnode_info_path  (1176 bytes)
# vnode_info_path = vnode_info (152 bytes) + char vip_path[1024]
# So the CWD string starts at byte offset 152.
_libproc: Optional[ctypes.CDLL] = None
_PROC_PIDVNODEPATHINFO   = 9
_PROC_VNODEPATHINFO_SIZE = 2352   # sizeof(struct proc_vnodepathinfo)
_CWD_PATH_OFFSET         = 152    # offsetof(pvi_cdir.vip_path) = sizeof(vnode_info)

def _get_proc_cwd(pid: int) -> Optional[str]:
    """Return the working directory of *pid* via macOS libproc (non-blocking)."""
    global _libproc
    try:
        if _libproc is None:
            _libproc = ctypes.CDLL('/usr/lib/libproc.dylib')
        buf = ctypes.create_string_buffer(_PROC_VNODEPATHINFO_SIZE)
        ret = _libproc.proc_pidinfo(
            ctypes.c_int(pid),
            ctypes.c_int(_PROC_PIDVNODEPATHINFO),
            ctypes.c_uint64(0),
            buf,
            ctypes.c_int(_PROC_VNODEPATHINFO_SIZE),
        )
        if ret > 0:
            raw = buf.raw[_CWD_PATH_OFFSET:_CWD_PATH_OFFSET + 1024]
            path = raw.split(b'\x00', 1)[0].decode('utf-8', errors='replace')
            return path or None
    except Exception:
        pass
    return None


@dataclass
class Window:
    id: str = field(default_factory=_uid)
    label: str = "Terminal"
    color: str = "#4ecdc4"
    group_id: Optional[str] = None


@dataclass
class Group:
    id: str = field(default_factory=_uid)
    name: str = "New Group"
    color: str = "#4ecdc4"
    collapsed: bool = False


_SCROLLBACK = 512 * 1024  # 512 KB per window


class WindowState:
    def __init__(self, window: Window) -> None:
        self.window = window
        self.pty: Optional[ptyprocess.PtyProcess] = None
        self._buf = bytearray()
        self.cwd: Optional[str] = None   # last known working directory

    def start(self, shell: str, cols: int, rows: int, cwd: Optional[str] = None) -> None:
        env = {**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor"}
        self.pty = ptyprocess.PtyProcess.spawn(
            [shell], dimensions=(rows, cols), env=env, cwd=cwd
        )
        if cwd:
            self.cwd = cwd

    def resize(self, cols: int, rows: int) -> None:
        if self.pty and self.pty.isalive():
            try:
                self.pty.setwinsize(rows, cols)
            except OSError:
                pass

    def write(self, data: bytes) -> None:
        if self.pty and self.pty.isalive():
            try:
                os.write(self.pty.fd, data)
            except OSError:
                pass

    def is_alive(self) -> bool:
        return self.pty is not None and self.pty.isalive()

    def is_busy(self) -> bool:
        """True when a child process is running in the foreground (shell spawned something)."""
        if not self.pty or not self.pty.isalive():
            return False
        try:
            return os.tcgetpgrp(self.pty.fd) != self.pty.pid
        except OSError:
            return False

    @property
    def fd(self) -> int:
        assert self.pty is not None
        return self.pty.fd


OutputCb = Callable[[str, bytes], Awaitable[None]]
CloseCb  = Callable[[str], Awaitable[None]]


class PtyManager:
    def __init__(self) -> None:
        self.windows: dict[str, WindowState] = {}
        self.groups: dict[str, Group] = {}
        self.order: list[str] = []
        self._readers: dict[int, str] = {}      # fd → window_id
        self._color_idx = 0
        self.on_output: Optional[OutputCb] = None
        self.on_closed: Optional[CloseCb]  = None

    # ── Window management ──────────────────────────────────────────

    def next_color(self) -> str:
        c = COLORS[self._color_idx % len(COLORS)]
        self._color_idx += 1
        return c

    def new_window(
        self,
        label: str = "Terminal",
        color: Optional[str] = None,
        group_id: Optional[str] = None,
        cols: int = 120,
        rows: int = 40,
        window_id: Optional[str] = None,
        cwd: Optional[str] = None,
    ) -> Window:
        win = Window(id=window_id or _uid(), label=label, color=color or self.next_color(), group_id=group_id)
        state = WindowState(win)
        state.start(os.environ.get("SHELL", "/bin/bash"), cols, rows, cwd=cwd)
        self.windows[win.id] = state
        self.order.append(win.id)

        loop = asyncio.get_running_loop()
        loop.add_reader(state.fd, self._readable, win.id, state.fd)
        self._readers[state.fd] = win.id
        return win

    def close_window(self, window_id: str) -> None:
        state = self.windows.pop(window_id, None)
        if state is None:
            return
        try:
            asyncio.get_running_loop().remove_reader(state.fd)
        except Exception:
            pass
        self._readers.pop(state.fd, None)
        try:
            state.pty.close(force=True)
        except Exception:
            pass
        if window_id in self.order:
            self.order.remove(window_id)

    # ── Group management ───────────────────────────────────────────

    def new_group(
        self,
        name: str = "New Group",
        color: str = "#4ecdc4",
        group_id: Optional[str] = None,
        collapsed: bool = False,
    ) -> Group:
        g = Group(id=group_id or _uid(), name=name, color=color, collapsed=collapsed)
        self.groups[g.id] = g
        return g

    # ── PTY reader callback ────────────────────────────────────────

    def _readable(self, window_id: str, fd: int) -> None:
        try:
            data = os.read(fd, 65536)
        except OSError:
            # EIO (or similar) means the slave PTY has closed — clean up.
            try:
                asyncio.get_running_loop().remove_reader(fd)
            except Exception:
                pass
            self._readers.pop(fd, None)
            if self.on_closed:
                asyncio.ensure_future(self.on_closed(window_id))
            return
        if not data:
            # Spurious wakeup (e.g. tcsetattr raw-mode switch by vi/vim).
            # The PTY is still alive — just nothing to read right now.
            return
        state = self.windows.get(window_id)
        if state is not None:
            state._buf.extend(data)
            if len(state._buf) > _SCROLLBACK:
                del state._buf[:len(state._buf) - _SCROLLBACK]
            # Real-time CWD tracking via OSC 7 (emitted by zsh/bash/fish prompts)
            cwd = _parse_osc7_cwd(data)
            if cwd is not None:
                state.cwd = cwd
        if self.on_output:
            asyncio.ensure_future(self.on_output(window_id, data))

    # ── Serialization ──────────────────────────────────────────────

    def state_dict(self) -> dict:
        return {
            "windows": [
                {
                    "id": s.window.id,
                    "label": s.window.label,
                    "color": s.window.color,
                    "groupId": s.window.group_id,
                    "busy": s.is_busy(),
                }
                for wid in self.order
                for s in [self.windows[wid]]
            ],
            "groups": [
                {"id": g.id, "name": g.name, "color": g.color, "collapsed": g.collapsed}
                for g in self.groups.values()
            ],
        }
