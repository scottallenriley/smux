"""Persistent daemon: runs the smux server independently of the pywebview window.

The daemon keeps PTY sessions alive after the window is closed.  A new window
reconnects to the already-running daemon rather than starting fresh.

Usage (internal — called by main.py):
    python -m smux.daemon
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
from pathlib import Path

from .server import run_server

_SMUX_DIR  = Path.home() / ".smux"
_INFO_FILE = _SMUX_DIR / "daemon.json"


async def _serve_forever() -> None:
    _SMUX_DIR.mkdir(exist_ok=True)
    runner, port = await run_server()

    info = {"pid": os.getpid(), "port": port}
    _INFO_FILE.write_text(json.dumps(info))

    # Graceful shutdown on SIGTERM / SIGINT
    loop = asyncio.get_running_loop()
    stop = loop.create_future()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set_result, None)

    await stop
    _INFO_FILE.unlink(missing_ok=True)
    await runner.cleanup()


def main() -> None:
    asyncio.run(_serve_forever())


if __name__ == "__main__":
    main()
