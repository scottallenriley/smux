"""Entry point: connects to (or starts) the persistent daemon, then opens the window."""
from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import webview

_SMUX_DIR  = Path.home() / ".smux"
_INFO_FILE = _SMUX_DIR / "daemon.json"
_STARTUP_TIMEOUT = 5.0   # seconds to wait for daemon to write its info file


def _port_responds(port: int, timeout: float = 1.5) -> bool:
    """Return True if the HTTP server on this port responds within timeout."""
    try:
        s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        s.sendall(b"GET / HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
        s.settimeout(timeout)
        data = s.recv(16)
        s.close()
        return len(data) > 0
    except Exception:
        return False


def _daemon_info() -> dict | None:
    """Return {pid, port} if a living, responsive daemon is recorded, else None."""
    try:
        info = json.loads(_INFO_FILE.read_text())
        pid = int(info["pid"])
        # Check the process is still alive (kill 0 = no-op, raises if dead)
        os.kill(pid, 0)
        # Also verify the HTTP server is actually responding — the event loop
        # can freeze (e.g. blocking tcgetpgrp on a stale PTY) while the process
        # stays alive, making the PID check a false positive.
        if not _port_responds(int(info["port"])):
            return None
        return info
    except Exception:
        return None


def _kill_stale_daemon() -> None:
    """Kill any daemon whose PID is recorded in the info file."""
    try:
        info = json.loads(_INFO_FILE.read_text())
        pid = int(info["pid"])
        os.kill(pid, signal.SIGTERM)
        # Give it a moment to exit cleanly
        for _ in range(20):
            time.sleep(0.05)
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
        else:
            # Still alive — force kill
            try:
                os.kill(pid, signal.SIGKILL)
            except Exception:
                pass
    except Exception:
        pass


def _start_daemon() -> int:
    """Spawn the daemon as a detached process. Returns its port."""
    _SMUX_DIR.mkdir(exist_ok=True)
    # Kill any stale/broken daemon before removing the info file
    _kill_stale_daemon()
    # Remove stale info file so we know when the new daemon is ready
    _INFO_FILE.unlink(missing_ok=True)

    if getattr(sys, 'frozen', False):
        # Frozen .app: re-invoke ourselves with --daemon flag
        cmd = [sys.executable, "--daemon"]
    else:
        cmd = [sys.executable, "-m", "smux.daemon"]

    subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )

    deadline = time.monotonic() + _STARTUP_TIMEOUT
    while time.monotonic() < deadline:
        info = _daemon_info()
        if info:
            return int(info["port"])
        time.sleep(0.05)

    raise RuntimeError("smux daemon did not start within timeout")


def main() -> None:
    info = _daemon_info()
    if info:
        port = int(info["port"])
    else:
        port = _start_daemon()

    webview.create_window(
        "smux",
        f"http://127.0.0.1:{port}",
        width=1440,
        height=900,
        min_size=(900, 600),
    )
    webview.start()


if __name__ == "__main__":
    main()
