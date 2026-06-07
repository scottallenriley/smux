# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Run

```bash
cd /Users/sar/code/smux
PYTHONPATH=src python -m smux.main
```

Or double-click `smux.app` (drag it to the Dock for quick access).

## Architecture

smux is a **standalone native macOS app** — a real NSWindow, no Terminal.app involved.

```
pywebview  →  native WKWebView window (NSWindow/WebKit)
aiohttp    →  local HTTP + WebSocket server  (random localhost port)
ptyprocess →  PTY processes (one per terminal window)
xterm.js   →  terminal rendering in the browser view
```

**Startup flow:**
1. `main.py` spawns an aiohttp server in a background thread (its own asyncio loop)
2. `webview.create_window()` opens a native macOS window pointing to `http://127.0.0.1:<port>`
3. JS connects via WebSocket; server creates the first PTY window on first connection
4. PTY output → `asyncio.add_reader` callback → WebSocket → `terminal.write(bytes)` in xterm.js
5. xterm.js `onData` → WebSocket → `os.write(pty.fd, bytes)`

### Python files (`src/smux/`)

| File | Role |
|---|---|
| `main.py` | Entry point: server thread + `webview.start()` |
| `pty_manager.py` | `PtyManager` + `WindowState`: PTY lifecycle, async fd readers |
| `server.py` | `SmuxServer`: aiohttp app, WebSocket handler, message dispatch |

### Frontend (`src/smux/static/`)

| File | Role |
|---|---|
| `index.html` | HTML shell (tab bar, sidebar, terminal container, overlays) |
| `app.css` | Dark theme (Tokyo Night palette), layout |
| `app.js` | `SmuxApp` class: WebSocket, xterm.js instances, tab/sidebar rendering, search, label dialog |
| `vendor/` | xterm.js 5.3, addon-fit, addon-search (served locally, no CDN) |

### WebSocket protocol

**Server → Client:**
- `{type:"state", windows:[…], groups:[…]}` — full state sync
- `{type:"output", windowId, data:base64}` — PTY bytes for xterm
- `{type:"window_created", window:{…}}` — new window
- `{type:"window_closed", windowId}` — PTY exited or closed

**Client → Server:**
- `{type:"input", windowId, data:base64}` — keystrokes (UTF-8 encoded)
- `{type:"resize", windowId, cols, rows}` — terminal resize
- `{type:"new_window", label?, color?, cols?, rows?}`
- `{type:"close_window", windowId}`
- `{type:"rename_window", windowId, label, color}`
- `{type:"new_group", name, color?}`
- `{type:"move_to_group", windowId, groupId}`
- `{type:"toggle_group", groupId}`

### Key details

- `ptyprocess` dimensions are `(rows, cols)` — opposite of most width/height conventions
- PTY readers are registered with `asyncio.get_running_loop().add_reader(fd, callback)` inside `new_window()`, which always runs in the aiohttp event loop (correct)
- `on_output` / `on_closed` callbacks on `PtyManager` are async functions; called via `asyncio.ensure_future()`
- xterm.js instances are kept alive (not destroyed) for all windows; inactive panes use `visibility:hidden` so `FitAddon` can always measure dimensions
- Search uses `xterm.buffer.active.getLine(y).translateToString(true)` across all xterm instances

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| ⌘T | New terminal |
| ⌘W | Close active terminal |
| ⌘F | Search all windows |
| ⌘] / ⌘[ | Next / previous tab |
| Double-click tab or sidebar item | Rename / recolor |
