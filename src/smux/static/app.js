'use strict';

// ── Helpers ────────────────────────────────────────────────────────────────

function encodeInput(str) {
  const bytes = new TextEncoder().encode(str);
  // Chunk to avoid stack overflow from spread and O(n²) string concat
  const CHUNK = 8192;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function decodeOutput(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Xterm theme (Tokyo Night) ──────────────────────────────────────────────

const XTERM_THEME = {
  background:    '#1a1b26',
  foreground:    '#c0caf5',
  cursor:        '#c0caf5',
  cursorAccent:  '#1a1b26',
  selectionBackground: '#364a82',
  black:         '#15161e', red:          '#f7768e',
  green:         '#9ece6a', yellow:       '#e0af68',
  blue:          '#7aa2f7', magenta:      '#bb9af7',
  cyan:          '#7dcfff', white:        '#a9b1d6',
  brightBlack:   '#414868', brightRed:    '#f7768e',
  brightGreen:   '#9ece6a', brightYellow: '#e0af68',
  brightBlue:    '#7aa2f7', brightMagenta:'#bb9af7',
  brightCyan:    '#7dcfff', brightWhite:  '#c0caf5',
};

const XTERM_THEME_LIGHT = {
  background:    '#fafafa',
  foreground:    '#2d2d2d',
  cursor:        '#2d2d2d',
  cursorAccent:  '#fafafa',
  selectionBackground: '#c8d3f5',
  black:         '#2d2d2d', red:          '#c94f6d',
  green:         '#3d7a52', yellow:       '#906b25',
  blue:          '#2959aa', magenta:      '#7847bd',
  cyan:          '#2a8f77', white:        '#6b6b6b',
  brightBlack:   '#777777', brightRed:    '#c94f6d',
  brightGreen:   '#3d7a52', brightYellow: '#906b25',
  brightBlue:    '#2959aa', brightMagenta:'#7847bd',
  brightCyan:    '#2a8f77', brightWhite:  '#2d2d2d',
};

const COLORS = ['#4ecdc4','#7aa2f7','#9ece6a','#e0af68','#bb9af7','#f7768e','#7dcfff','#fab387'];

// ── SmuxApp ────────────────────────────────────────────────────────────────

class SmuxApp {
  constructor() {
    /** @type {{ id:string, label:string, color:string, groupId:string|null }[]} */
    this.windows = [];
    /** @type {{ id:string, name:string, color:string, collapsed:boolean }[]} */
    this.groups  = [];
    /** @type {string|null} */
    this.activeId  = null;
    /** @type {string|null} focused pane within a split */
    this.focusedId = null;
    /** @type {Map<string, { xterm: Terminal, fit: FitAddon, search: SearchAddon, el: HTMLElement }>} */
    this.terms = new Map();
    /** @type {Object.<string,{dir:'v'|'h', ratio:number, secondaryId:string}>} primaryId → split */
    this.splits = {};
    /** @type {{primaryId:string, dir:'v'|'h'}|null} */
    this._pendingSplit = null;

    /** @type {{windowId:string, label:string, color:string, text:string}[]} */
    this.historyLines = [];

    this._ws = null;
    this._reconnectTimer = null;

    this._initUI();
    this._connect();
  }

  // ── WebSocket ─────────────────────────────────────────────────────────

  _connect() {
    if (this._ws) { try { this._ws.close(); } catch(_) {} }
    this._ws = new WebSocket(`ws://${location.host}/ws`);
    this._ws.onopen    = () => { clearTimeout(this._reconnectTimer); };
    this._ws.onmessage = e  => this._onMessage(JSON.parse(e.data));
    this._ws.onclose   = () => { this._reconnectTimer = setTimeout(() => this._connect(), 800); };
    this._ws.onerror   = () => { this._ws.close(); };
  }

  _send(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN)
      this._ws.send(JSON.stringify(msg));
  }

  // Signal the server to paste from the macOS clipboard into a PTY window.
  // The server reads the clipboard itself (via pbpaste / AppleScript) and writes
  // to the PTY in chunks, completely server-side.  No clipboard data ever passes
  // through WKWebView's JS heap — that serialisation step was the crash source
  // for large pastes.
  _paste(windowId) {
    this._send({ type: 'paste_from_clipboard', windowId });
  }

  // ── Message dispatch ──────────────────────────────────────────────────

  _onMessage(msg) {
    switch (msg.type) {
      case 'state':
        this.windows = msg.windows || [];
        this.groups  = msg.groups  || [];
        for (const w of this.windows) {
          if (!this.terms.has(w.id)) {
            this._createTerm(w);
          } else {
            // Keep pane accent color in sync
            const t = this.terms.get(w.id);
            t.el.style.setProperty('--win-color', w.color);
          }
        }
        this._renderTabs();
        this._renderSidebar();
        if (!this.activeId && this.windows.length) this._activate(this.windows[0].id);
        break;

      case 'output':
        this._write(msg.windowId, decodeOutput(msg.data));
        break;

      case 'window_created': {
        const w = msg.window;
        this.windows.push(w);
        this._createTerm(w);
        this._renderTabs();
        this._renderSidebar();
        if (this._pendingSplit) {
          const { primaryId, dir } = this._pendingSplit;
          this._pendingSplit = null;
          this.splits[primaryId] = { dir, ratio: 0.5, secondaryId: w.id };
          this.activeId  = primaryId;
          this.focusedId = w.id;
          this._renderTermContainer();
        } else {
          this._activate(w.id);
        }
        break;
      }

      case 'window_closed':
        this._removeTerm(msg.windowId);
        break;
    }
  }

  // ── Terminal lifecycle ────────────────────────────────────────────────

  _createTerm(win) {
    const container = document.getElementById('term-container');
    const el = document.createElement('div');
    el.className = 'terminal-pane';
    el.id = `pane-${win.id}`;
    el.style.setProperty('--win-color', win.color);
    container.appendChild(el);

    const s = this.settings || { theme: 'dark', fontSize: 14, fontFace: 'system' };
    const xterm = new Terminal({
      cursorBlink: true,
      fontSize: s.fontSize,
      fontFamily: s.fontFace === 'system'
        ? '"SF Mono", "Fira Code", Menlo, Monaco, monospace'
        : `"${s.fontFace}", monospace`,
      theme: s.theme === 'light' ? XTERM_THEME_LIGHT : XTERM_THEME,
      allowProposedApi: true,
      scrollback: 50000,
    });

    const fit    = new FitAddon.FitAddon();
    const search = new SearchAddon.SearchAddon();
    xterm.loadAddon(fit);
    xterm.loadAddon(search);

    // Make visible briefly so FitAddon can measure
    el.style.visibility = 'visible';
    xterm.open(el);
    fit.fit();
    el.style.visibility = '';  // restored by _renderTermContainer

    xterm.onData(data => {
      // onData fires for keyboard input only — paste is fully intercepted below.
      // Keyboard input is always tiny so a single send is fine.
      this._send({ type: 'input', windowId: win.id, data: encodeInput(data) });
    });

    xterm.onResize(({ cols, rows }) => {
      this._send({ type: 'resize', windowId: win.id, cols, rows });
    });

    // Capture-phase paste handler — fires before xterm.js sees the event.
    // We prevent the default and let the server handle the clipboard read and PTY
    // write entirely.  Never touch clipboardData here — accessing large clipboard
    // content in WKWebView's JS heap is what caused the crash.
    el.addEventListener('paste', e => {
      e.preventDefault();
      e.stopPropagation();
      this._paste(win.id);
    }, true);

    // Right-click context menu on the terminal pane
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      const hasSel = !!xterm.getSelection();
      this._showContextMenu(e.clientX, e.clientY, [
        { label: 'Copy',       action: () => { const s = xterm.getSelection(); if (s) navigator.clipboard.writeText(s); }, },
        { label: 'Paste',      action: () => this._paste(win.id) },
        'separator',
        { label: 'Select All', action: () => xterm.selectAll() },
      ]);
    }, true); // capture phase so xterm doesn't eat it

    // Clicking a pane focuses it (important for split view)
    el.addEventListener('mousedown', () => {
      const split = this._getSplitFor(win.id);
      if (split && this.focusedId !== win.id) {
        this.focusedId = win.id;
        xterm.focus();
        this._renderTermContainer();
      }
    });

    this.terms.set(win.id, { xterm, fit, search, el });
  }

  _write(windowId, bytes) {
    const t = this.terms.get(windowId);
    if (!t) return;
    this._addToHistory(windowId, bytes);
    t.xterm.write(bytes, () => {
      // After xterm processes the chunk, keep the viewport pinned to the
      // cursor so the prompt is always visible (prevents scroll-back on
      // large bursts of output).
      if (windowId === this.activeId || windowId === this.focusedId) {
        t.xterm.scrollToBottom();
      }
    });
  }

  _stripAnsi(str) {
    return str
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')   // CSI sequences
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC sequences
      .replace(/\x1b./g, '')                      // other escapes
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // control chars
  }

  _addToHistory(windowId, bytes) {
    const raw  = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const text = this._stripAnsi(raw).replace(/\r/g, '');
    const lines = text.split('\n').filter(l => l.trim());
    if (!lines.length) return;

    const win   = this.windows.find(w => w.id === windowId);
    const label = win ? win.label : 'Terminal';
    const color = win ? win.color : '#888';

    for (const line of lines) {
      this.historyLines.push({ windowId, label, color, text: line });
    }
    // Cap at 50,000 lines to match scrollback
    if (this.historyLines.length > 50000) {
      this.historyLines.splice(0, this.historyLines.length - 50000);
    }
    this._updateHistoryCounter();
  }

  _updateHistoryCounter() {
    const el = document.getElementById('history-counter');
    if (el) el.textContent = this.historyLines.length.toLocaleString() + ' lines';
  }

  _showHistoryOverlay() {
    const overlay  = document.getElementById('history-overlay');
    const linesEl  = document.getElementById('history-lines');
    const countEl  = document.getElementById('history-line-count');
    const MAX_SHOW = 500;
    const total    = this.historyLines.length;
    const slice    = this.historyLines.slice(-MAX_SHOW);

    linesEl.innerHTML = '';
    for (const entry of slice) {
      const row  = document.createElement('div');
      row.className = 'history-entry';
      const tag  = document.createElement('span');
      tag.className = 'history-tag';
      tag.style.background = entry.color;
      tag.textContent = entry.label.slice(0, 10);
      const txt  = document.createElement('span');
      txt.className = 'history-text';
      txt.textContent = entry.text;
      row.appendChild(tag);
      row.appendChild(txt);
      linesEl.appendChild(row);
    }
    linesEl.scrollTop = linesEl.scrollHeight;

    countEl.textContent = total > MAX_SHOW
      ? `Showing last ${MAX_SHOW.toLocaleString()} of ${total.toLocaleString()} lines`
      : `${total.toLocaleString()} lines`;

    overlay.classList.remove('hidden');
  }

  _activate(windowId) {
    this.activeId  = windowId;
    this.focusedId = windowId;
    this._renderTermContainer();
    this._renderTabs();
    this._renderSidebar();
  }

  _removeTerm(windowId) {
    // Clean up any split involving this window
    const split = this._getSplitFor(windowId);
    if (split) {
      delete this.splits[split.primaryId];
      const otherId = windowId === split.primaryId ? split.secondaryId : split.primaryId;
      if (this.activeId === windowId || this.focusedId === windowId) {
        this.activeId  = otherId;
        this.focusedId = otherId;
      }
    }

    const t = this.terms.get(windowId);
    if (t) { t.xterm.dispose(); t.el.remove(); this.terms.delete(windowId); }
    this.windows = this.windows.filter(w => w.id !== windowId);

    if (this.activeId === windowId) {
      this.activeId  = null;
      this.focusedId = null;
      if (this.windows.length) this._activate(this.windows[this.windows.length - 1].id);
    }
    this._renderTermContainer();
    this._renderTabs();
    this._renderSidebar();
  }

  // ── Split management ──────────────────────────────────────────────────

  _getSplitFor(windowId) {
    if (this.splits[windowId])
      return { primaryId: windowId, ...this.splits[windowId] };
    for (const [pid, e] of Object.entries(this.splits)) {
      if (e.secondaryId === windowId)
        return { primaryId: pid, secondaryId: windowId, dir: e.dir, ratio: e.ratio };
    }
    return null;
  }

  _splitWindow(dir) {
    if (!this.activeId) return;
    // Find the primary of any existing split
    const existing = this._getSplitFor(this.activeId);
    const primaryId = existing ? existing.primaryId : this.activeId;
    if (this.splits[primaryId]) return; // already split (one level only for now)

    const win = this.windows.find(w => w.id === this.activeId);
    const t   = this.terms.get(this.activeId);
    this._pendingSplit = { primaryId, dir };
    this._send({
      type: 'new_window',
      label: (win ? win.label : 'Terminal'),
      color: win ? win.color : '#4ecdc4',
      groupId: win ? win.groupId : null,
      cols: t ? t.xterm.cols : 80,
      rows: t ? t.xterm.rows : 24,
    });
  }

  _removeSplit() {
    if (!this.activeId) return;
    const split = this._getSplitFor(this.activeId);
    if (!split) return;
    delete this.splits[split.primaryId];
    this.activeId  = split.primaryId;
    this.focusedId = split.primaryId;
    this._renderTermContainer();
    this._renderTabs();
    this._renderSidebar();
  }

  // ── Terminal container rendering ──────────────────────────────────────

  _renderTermContainer() {
    const container = document.getElementById('term-container');
    // Remove old dividers
    container.querySelectorAll('.split-divider').forEach(d => d.remove());

    // Reset all panes to hidden
    this.terms.forEach(({ el }) => {
      el.classList.remove('active', 'split-a', 'split-b', 'split-focused');
      el.style.removeProperty('top');
      el.style.removeProperty('bottom');
      el.style.removeProperty('left');
      el.style.removeProperty('right');
      el.style.removeProperty('visibility');
      el.style.removeProperty('pointer-events');
    });

    if (!this.activeId) return;

    const split = this._getSplitFor(this.activeId);

    if (!split) {
      // Single pane
      const t = this.terms.get(this.activeId);
      if (t) {
        t.el.classList.add('active');
        t.fit.fit();
        t.xterm.scrollToBottom();
        t.xterm.focus();
      }
      return;
    }

    // Split view
    const { primaryId, secondaryId, dir, ratio } = split;
    const tA = this.terms.get(primaryId);
    const tB = this.terms.get(secondaryId);
    if (!tA || !tB) return;

    const GAP = 4;
    const pct = (ratio * 100).toFixed(3);

    if (dir === 'v') {
      tA.el.style.cssText = `visibility:visible;pointer-events:all;right:calc(${100 - ratio * 100}% + ${GAP / 2}px)`;
      tB.el.style.cssText = `visibility:visible;pointer-events:all;left:calc(${pct}% + ${GAP / 2}px)`;
      const div = document.createElement('div');
      div.className = 'split-divider split-divider-v';
      div.style.left = `calc(${pct}% - ${GAP / 2}px)`;
      container.appendChild(div);
      this._addDividerDrag(div, primaryId, dir);
    } else {
      tA.el.style.cssText = `visibility:visible;pointer-events:all;bottom:calc(${100 - ratio * 100}% + ${GAP / 2}px)`;
      tB.el.style.cssText = `visibility:visible;pointer-events:all;top:calc(${pct}% + ${GAP / 2}px)`;
      const div = document.createElement('div');
      div.className = 'split-divider split-divider-h';
      div.style.top = `calc(${pct}% - ${GAP / 2}px)`;
      container.appendChild(div);
      this._addDividerDrag(div, primaryId, dir);
    }

    // Focus ring on focused pane
    if (this.focusedId === primaryId)  tA.el.classList.add('split-focused');
    if (this.focusedId === secondaryId) tB.el.classList.add('split-focused');

    tA.fit.fit();
    tA.xterm.scrollToBottom();
    tB.fit.fit();
    tB.xterm.scrollToBottom();
    const focused = this.terms.get(this.focusedId);
    if (focused) focused.xterm.focus();
  }

  _addDividerDrag(divEl, primaryId, dir) {
    divEl.addEventListener('pointerdown', e => {
      e.preventDefault();
      divEl.setPointerCapture(e.pointerId);
      divEl.classList.add('dragging');
      const container = document.getElementById('term-container');
      const rect = container.getBoundingClientRect();

      const onMove = e => {
        let ratio = dir === 'v'
          ? (e.clientX - rect.left) / rect.width
          : (e.clientY - rect.top)  / rect.height;
        ratio = Math.max(0.15, Math.min(0.85, ratio));
        this.splits[primaryId].ratio = ratio;
        this._renderTermContainer();
      };

      const onUp = () => {
        divEl.classList.remove('dragging');
        divEl.removeEventListener('pointermove', onMove);
        divEl.removeEventListener('pointerup', onUp);
      };

      divEl.addEventListener('pointermove', onMove);
      divEl.addEventListener('pointerup', onUp);
    });
  }

  // ── Active group helpers ──────────────────────────────────────────────

  _activeGroupId() {
    // The active group is the groupId of the currently active window
    const win = this.windows.find(w => w.id === this.activeId);
    return win ? (win.groupId || null) : null;
  }

  _tabsForActiveGroup() {
    const gid = this._activeGroupId();
    return this.windows.filter(w => (w.groupId || null) === gid);
  }

  // ── Tab rendering ─────────────────────────────────────────────────────

  _renderTabs() {
    const el = document.getElementById('tabs');
    el.innerHTML = '';
    // Only show tabs belonging to the same group as the active window
    for (const w of this._tabsForActiveGroup()) {
      const tab = document.createElement('div');
      tab.className = 'tab' + (w.id === this.activeId ? ' active' : '') + (w.busy ? ' busy' : '');
      tab.innerHTML =
        `<span class="tab-dot" style="color:${escHtml(w.color)}">●</span>` +
        `<span class="tab-label">${escHtml(w.label)}</span>` +
        `<span class="tab-close" data-id="${w.id}">✕</span>`;

      tab.addEventListener('mousedown', e => {
        if (e.target.classList.contains('tab-close')) {
          e.preventDefault();
          this._send({ type: 'close_window', windowId: w.id });
        } else {
          this._activate(w.id);
        }
      });

      tab.addEventListener('contextmenu', e => {
        e.preventDefault();
        const hasSplit = !!this._getSplitFor(w.id);
        this._showContextMenu(e.clientX, e.clientY, [
          { label: 'Rename / Recolor', action: () => this._showLabelDialog(w) },
          'separator',
          ...(!hasSplit ? [
            { label: 'Split Vertically',   action: () => { this._activate(w.id); this._splitWindow('v'); } },
            { label: 'Split Horizontally', action: () => { this._activate(w.id); this._splitWindow('h'); } },
          ] : [
            { label: 'Remove Split', action: () => { this.activeId = w.id; this._removeSplit(); } },
          ]),
          'separator',
          { label: 'Close', danger: true, action: () => this._send({ type: 'close_window', windowId: w.id }) },
        ]);
      });

      el.appendChild(tab);
    }
  }

  // ── Drag state ────────────────────────────────────────────────────────

  _dragStart(windowId, el) {
    this._draggingId = windowId;
    el.classList.add('dragging');
  }

  _dragEnd(el) {
    this._draggingId = null;
    el.classList.remove('dragging');
    // Clear any leftover drop-target highlights
    document.querySelectorAll('.drop-target').forEach(e => e.classList.remove('drop-target'));
  }

  _makeDropTarget(el, groupId) {
    el.addEventListener('dragover', e => {
      if (!this._draggingId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('drop-target');
      if (this._draggingId) {
        const win = this.windows.find(w => w.id === this._draggingId);
        if (win && win.groupId !== groupId) {
          this._send({ type: 'move_to_group', windowId: this._draggingId, groupId });
          win.groupId = groupId;   // optimistic
          this._renderTabs();
          this._renderSidebar();
        }
      }
    });
  }

  // ── Sidebar rendering ─────────────────────────────────────────────────

  _renderSidebar() {
    const el = document.getElementById('window-list');
    el.innerHTML = '';

    // Ungrouped drop zone (only shown when there are groups)
    if (this.groups.length) {
      const dz = document.createElement('div');
      dz.className = 'drop-zone-ungrouped';
      dz.title = 'Drop here to ungroup';
      this._makeDropTarget(dz, null);
      el.appendChild(dz);
    }

    const ungrouped = this.windows.filter(w => !w.groupId);
    for (const w of ungrouped) el.appendChild(this._makeWinItem(w, false));

    for (const g of this.groups) {
      const members = this.windows.filter(w => w.groupId === g.id);
      const isActiveGroup = this._activeGroupId() === g.id;

      const hdr = document.createElement('div');
      hdr.className = 'group-header' + (isActiveGroup ? ' active-group' : '');
      this._makeDropTarget(hdr, g.id);

      const arrow = document.createElement('span');
      arrow.className = 'group-arrow';
      arrow.textContent = g.collapsed ? '▶' : '▼';
      arrow.addEventListener('click', e => {
        e.stopPropagation();
        this._send({ type: 'toggle_group', groupId: g.id });
      });

      const name = document.createElement('span');
      name.className = 'group-name';
      name.style.color = g.color;
      name.textContent = g.name;

      hdr.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        this._showContextMenu(e.clientX, e.clientY, [
          { label: 'Rename / Recolor', action: () => this._showGroupDialog(g) },
        ]);
      });

      const count = document.createElement('span');
      count.className = 'group-count';
      count.textContent = members.length;

      const addBtn = document.createElement('button');
      addBtn.className = 'group-add-btn';
      addBtn.title = `New terminal in ${g.name}`;
      addBtn.textContent = '＋';
      addBtn.addEventListener('click', e => {
        e.stopPropagation();
        this._newWindowInGroup(g.id);
      });

      hdr.append(arrow, name, count, addBtn);

      hdr.addEventListener('click', () => {
        const first = members[0];
        if (first) this._activate(first.id);
      });

      el.appendChild(hdr);

      if (!g.collapsed) {
        for (const w of members) el.appendChild(this._makeWinItem(w, true));
      }
    }
  }

  _newWindowInGroup(groupId) {
    this._showNewTermDialog(groupId);
  }

  _showNewTermDialog(groupId = null) {
    const overlay    = document.getElementById('new-term-overlay');
    const labelInput = document.getElementById('new-term-label');
    const swatchBox  = document.getElementById('new-term-swatches');
    const okBtn      = document.getElementById('new-term-ok');
    const cancelBtn  = document.getElementById('new-term-cancel');

    // Pick a default color (next in rotation after last window)
    const usedColors = this.windows.map(w => w.color);
    const defaultColor = COLORS.find(c => !usedColors.includes(c)) || COLORS[this.windows.length % COLORS.length];
    let chosenColor = defaultColor;

    labelInput.value = '';
    swatchBox.innerHTML = '';
    COLORS.forEach(c => {
      const s = document.createElement('div');
      s.className = 'swatch' + (c === chosenColor ? ' selected' : '');
      s.style.background = c;
      s.addEventListener('click', () => {
        swatchBox.querySelectorAll('.swatch').forEach(x => x.classList.remove('selected'));
        s.classList.add('selected');
        chosenColor = c;
      });
      swatchBox.appendChild(s);
    });

    overlay.classList.remove('hidden');
    labelInput.focus();

    const cleanup = () => overlay.classList.add('hidden');
    const doCreate = () => {
      const t = this.terms.get(this.activeId);
      this._send({
        type: 'new_window',
        label: labelInput.value.trim() || 'Terminal',
        color: chosenColor,
        groupId,
        cols: t ? t.xterm.cols : 120,
        rows: t ? t.xterm.rows : 40,
      });
      cleanup();
    };

    okBtn.onclick       = doCreate;
    cancelBtn.onclick   = cleanup;
    labelInput.onkeydown = e => {
      if (e.key === 'Enter')  doCreate();
      if (e.key === 'Escape') cleanup();
    };
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) cleanup(); }, { once: true });
  }

  _makeWinItem(win, indented) {
    const el = document.createElement('div');
    const isIdle = !win.busy && win.id !== this.activeId;
    el.className = 'win-item' +
      (indented ? ' indented' : '') +
      (win.id === this.activeId ? ' active' : '') +
      (win.busy ? ' busy' : '');
    el.draggable = true;
    el.innerHTML =
      `<span class="win-dot" style="color:${escHtml(win.color)}">●</span>` +
      `<span class="win-label">${escHtml(win.label)}</span>` +
      (isIdle ? `<span class="win-idle-badge" title="Waiting for input"></span>` : '');
    el.addEventListener('dragstart', e => { e.dataTransfer.effectAllowed = 'move'; this._dragStart(win.id, el); });
    el.addEventListener('dragend',   () => this._dragEnd(el));
    el.addEventListener('click', () => this._activate(win.id));
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      const hasSplit = !!this._getSplitFor(win.id);
      this._showContextMenu(e.clientX, e.clientY, [
        { label: 'Rename / Recolor', action: () => this._showLabelDialog(win) },
        'separator',
        ...(!hasSplit ? [
          { label: 'Split Vertically',   action: () => { this._activate(win.id); this._splitWindow('v'); } },
          { label: 'Split Horizontally', action: () => { this._activate(win.id); this._splitWindow('h'); } },
        ] : [
          { label: 'Remove Split', action: () => { this.activeId = win.id; this._removeSplit(); } },
        ]),
        'separator',
        { label: 'Close', danger: true, action: () => this._send({ type: 'close_window', windowId: win.id }) },
      ]);
    });
    return el;
  }

  // ── Search (all terminals) ────────────────────────────────────────────

  _searchAll(query) {
    if (!query) return [];
    const q = query.toLowerCase();
    const results = [];
    for (const w of this.windows) {
      const t = this.terms.get(w.id);
      if (!t) continue;
      const buf = t.xterm.buffer.active;
      for (let y = 0; y < buf.length; y++) {
        const line = buf.getLine(y);
        if (!line) continue;
        const text = line.translateToString(true);
        if (text.toLowerCase().includes(q)) {
          results.push({ windowId: w.id, label: w.label, color: w.color, text });
        }
      }
    }
    return results;
  }

  _showNewGroupDialog() { this._showGroupDialog(null); }

  _showGroupDialog(existingGroup) {
    const overlay   = document.getElementById('group-overlay');
    const title     = overlay.querySelector('.overlay-title');
    const nameInput = document.getElementById('group-name-input');
    const swatchBox = document.getElementById('group-color-swatches');
    const okBtn     = document.getElementById('group-ok');
    const cancelBtn = document.getElementById('group-cancel');

    const editing = existingGroup != null;
    title.textContent = editing ? 'Edit Group' : 'New Group';
    okBtn.textContent = editing ? 'Save' : 'Create';

    let chosenColor = editing ? existingGroup.color : COLORS[0];
    nameInput.value = editing ? existingGroup.name : '';

    swatchBox.innerHTML = '';
    COLORS.forEach(c => {
      const s = document.createElement('div');
      s.className = 'swatch' + (c === chosenColor ? ' selected' : '');
      s.style.background = c;
      s.addEventListener('click', () => {
        swatchBox.querySelectorAll('.swatch').forEach(x => x.classList.remove('selected'));
        s.classList.add('selected');
        chosenColor = c;
      });
      swatchBox.appendChild(s);
    });

    overlay.classList.remove('hidden');
    nameInput.focus();
    if (editing) nameInput.select();

    const cleanup = () => overlay.classList.add('hidden');
    const doOK = () => {
      const name = nameInput.value.trim();
      if (!name) return;
      if (editing) {
        this._send({ type: 'rename_group', groupId: existingGroup.id, name, color: chosenColor });
        // Optimistic local update
        const g = this.groups.find(x => x.id === existingGroup.id);
        if (g) { g.name = name; g.color = chosenColor; }
        this._renderSidebar();
      } else {
        this._send({ type: 'new_group', name, color: chosenColor });
      }
      cleanup();
    };

    okBtn.onclick     = doOK;
    cancelBtn.onclick = cleanup;
    nameInput.onkeydown = e => {
      if (e.key === 'Enter')  doOK();
      if (e.key === 'Escape') cleanup();
    };
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) cleanup(); }, { once: true });
  }

  _showSearchOverlay() {
    const overlay = document.getElementById('search-overlay');
    const input   = document.getElementById('search-input');
    const results = document.getElementById('search-results');
    const count   = document.getElementById('search-count');

    input.value = '';
    results.innerHTML = '';
    count.textContent = '';
    overlay.classList.remove('hidden');
    input.focus();

    const doSearch = () => {
      const q = input.value.trim();
      results.innerHTML = '';
      if (!q) { count.textContent = ''; return; }

      const hits = this._searchAll(q);
      count.textContent = `${hits.length} result${hits.length !== 1 ? 's' : ''}`;

      hits.slice(0, 200).forEach(hit => {
        const row = document.createElement('div');
        row.className = 'search-result';
        row.innerHTML =
          `<span class="win-tag" style="color:${escHtml(hit.color)}">[${escHtml(hit.label)}]</span>` +
          escHtml(hit.text.trim());
        row.addEventListener('click', () => {
          this._activate(hit.windowId);
          overlay.classList.add('hidden');
        });
        results.appendChild(row);
      });
    };

    input.addEventListener('input', doSearch);

    const close = e => {
      if (e.key === 'Escape') { overlay.classList.add('hidden'); document.removeEventListener('keydown', close); }
    };
    document.addEventListener('keydown', close);

    // Click outside to close
    overlay.addEventListener('mousedown', e => {
      if (e.target === overlay) overlay.classList.add('hidden');
    }, { once: true });
  }

  // ── Context menu ─────────────────────────────────────────────────────

  _showContextMenu(x, y, items) {
    const menu = document.getElementById('ctx-menu');
    menu.innerHTML = '';

    for (const item of items) {
      if (item === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'ctx-separator';
        menu.appendChild(sep);
      } else {
        const el = document.createElement('div');
        el.className = 'ctx-item' + (item.danger ? ' danger' : '');
        el.textContent = item.label;
        el.addEventListener('mousedown', e => {
          e.preventDefault();
          this._hideContextMenu();
          item.action();
        });
        menu.appendChild(el);
      }
    }

    // Position — keep inside viewport
    menu.classList.add('visible');
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    menu.style.left = Math.min(x, vw - mw - 6) + 'px';
    menu.style.top  = Math.min(y, vh - mh - 6) + 'px';
  }

  _hideContextMenu() {
    document.getElementById('ctx-menu').classList.remove('visible');
  }

  // ── Label / recolor dialog ────────────────────────────────────────────

  _showLabelDialog(win) {
    const overlay    = document.getElementById('label-overlay');
    const labelInput = document.getElementById('label-input');
    const swatchBox  = document.getElementById('color-swatches');
    const okBtn      = document.getElementById('label-ok');
    const cancelBtn  = document.getElementById('label-cancel');

    let chosenColor = win.color;
    labelInput.value = win.label;

    swatchBox.innerHTML = '';
    COLORS.forEach(c => {
      const s = document.createElement('div');
      s.className = 'swatch' + (c === chosenColor ? ' selected' : '');
      s.style.background = c;
      s.title = c;
      s.addEventListener('click', () => {
        swatchBox.querySelectorAll('.swatch').forEach(x => x.classList.remove('selected'));
        s.classList.add('selected');
        chosenColor = c;
      });
      swatchBox.appendChild(s);
    });

    overlay.classList.remove('hidden');
    labelInput.focus();
    labelInput.select();

    const cleanup = () => overlay.classList.add('hidden');

    const doOK = () => {
      const label = labelInput.value.trim() || win.label;
      this._send({ type: 'rename_window', windowId: win.id, label, color: chosenColor });
      // Optimistically update local state so sidebar/tabs refresh immediately
      const w = this.windows.find(x => x.id === win.id);
      if (w) { w.label = label; w.color = chosenColor; }
      const t = this.terms.get(win.id);
      if (t) t.el.style.setProperty('--win-color', chosenColor);
      this._renderTabs();
      this._renderSidebar();
      cleanup();
    };

    // Replace listeners to avoid duplicates
    okBtn.onclick     = doOK;
    cancelBtn.onclick = cleanup;

    labelInput.onkeydown = e => {
      if (e.key === 'Enter')  doOK();
      if (e.key === 'Escape') cleanup();
    };

    overlay.addEventListener('mousedown', e => {
      if (e.target === overlay) cleanup();
    }, { once: true });
  }

  // ── Snippets ──────────────────────────────────────────────────────────

  _loadSnippets() {
    try { return JSON.parse(localStorage.getItem('smux-snippets') || '[]'); }
    catch(_) { return []; }
  }

  _saveSnippets(snippets) {
    localStorage.setItem('smux-snippets', JSON.stringify(snippets));
  }

  _insertSnippet(content) {
    if (!this.activeId) return;
    this._send({ type: 'input', windowId: this.activeId, data: encodeInput(content) });
  }

  _showSnippetsOverlay() {
    const overlay = document.getElementById('snippets-overlay');
    overlay.classList.remove('hidden');
    this._renderSnippetList();

    document.getElementById('btn-new-snippet').onclick = () => {
      overlay.classList.add('hidden');
      this._showSnippetEditOverlay(null, () => {
        overlay.classList.remove('hidden');
        this._renderSnippetList();
      });
    };

    document.getElementById('snippets-close').onclick = () => overlay.classList.add('hidden');
    overlay.addEventListener('mousedown', e => {
      if (e.target === overlay) overlay.classList.add('hidden');
    }, { once: true });
  }

  _renderSnippetList() {
    const list = document.getElementById('snippet-list');
    list.innerHTML = '';
    const snippets = this._loadSnippets();

    for (const snip of snippets) {
      const row = document.createElement('div');
      row.className = 'snippet-row';
      row.title = 'Click to insert';

      const name    = document.createElement('span');
      name.className = 'snippet-name';
      name.textContent = snip.name;

      const preview = document.createElement('span');
      preview.className = 'snippet-preview';
      preview.textContent = snip.content.replace(/\n/g, ' ↵ ');

      const insertBtn = document.createElement('button');
      insertBtn.className = 'snippet-insert-btn';
      insertBtn.textContent = 'Insert';
      insertBtn.addEventListener('click', e => {
        e.stopPropagation();
        this._insertSnippet(snip.content);
        document.getElementById('snippets-overlay').classList.add('hidden');
      });

      row.append(name, preview, insertBtn);

      row.addEventListener('contextmenu', e => {
        e.preventDefault();
        this._showContextMenu(e.clientX, e.clientY, [
          { label: 'Edit', action: () => {
              document.getElementById('snippets-overlay').classList.add('hidden');
              this._showSnippetEditOverlay(snip, () => {
                document.getElementById('snippets-overlay').classList.remove('hidden');
                this._renderSnippetList();
              });
          }},
          'separator',
          { label: 'Delete', danger: true, action: () => {
              const all = this._loadSnippets().filter(s => s.id !== snip.id);
              this._saveSnippets(all);
              this._renderSnippetList();
          }},
        ]);
      });

      list.appendChild(row);
    }
  }

  _showSnippetEditOverlay(existing, onDone) {
    const overlay   = document.getElementById('snippet-edit-overlay');
    const title     = document.getElementById('snippet-edit-title');
    const nameInput = document.getElementById('snippet-name-input');
    const bodyInput = document.getElementById('snippet-body-input');
    const okBtn     = document.getElementById('snippet-edit-ok');
    const cancelBtn = document.getElementById('snippet-edit-cancel');

    title.textContent = existing ? 'Edit Snippet' : 'New Snippet';
    nameInput.value = existing ? existing.name : '';
    bodyInput.value = existing ? existing.content : '';

    overlay.classList.remove('hidden');
    nameInput.focus();

    const cleanup = () => overlay.classList.add('hidden');

    const doSave = () => {
      const name    = nameInput.value.trim();
      const content = bodyInput.value;
      if (!name || !content) return;
      const all = this._loadSnippets();
      if (existing) {
        const idx = all.findIndex(s => s.id === existing.id);
        if (idx >= 0) all[idx] = { ...existing, name, content };
      } else {
        all.push({ id: Date.now().toString(36), name, content });
      }
      this._saveSnippets(all);
      cleanup();
      if (onDone) onDone();
    };

    okBtn.onclick     = doSave;
    cancelBtn.onclick = () => { cleanup(); if (onDone) onDone(); };
    nameInput.onkeydown = e => { if (e.key === 'Escape') { cleanup(); if (onDone) onDone(); } };
    overlay.addEventListener('mousedown', e => {
      if (e.target === overlay) { cleanup(); if (onDone) onDone(); }
    }, { once: true });
  }

  // ── Hosts ─────────────────────────────────────────────────────────────

  async _showHostsOverlay() {
    const overlay = document.getElementById('hosts-overlay');
    overlay.classList.remove('hidden');
    await this._renderHostList();

    document.getElementById('btn-new-host').onclick = () => {
      overlay.classList.add('hidden');
      this._showHostEditOverlay(null, async () => {
        overlay.classList.remove('hidden');
        await this._renderHostList();
      });
    };

    document.getElementById('hosts-close').onclick = () => overlay.classList.add('hidden');
    overlay.addEventListener('mousedown', e => {
      if (e.target === overlay) overlay.classList.add('hidden');
    }, { once: true });
  }

  async _renderHostList() {
    const list = document.getElementById('host-list');
    list.innerHTML = '';
    let hosts = [];
    try { hosts = await fetch('/hosts').then(r => r.json()); } catch(_) {}

    if (!hosts.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-dim);font-size:12px;padding:12px 10px;';
      empty.textContent = 'No hosts yet. Click "+ New Host" to add one.';
      list.appendChild(empty);
      return;
    }

    for (const host of hosts) {
      const row = document.createElement('div');
      row.className = 'host-row';

      const name = document.createElement('span');
      name.className = 'host-name';
      name.textContent = host.name;

      const cmd = document.createElement('span');
      cmd.className = 'host-cmd';
      cmd.textContent = host.command;

      const connectBtn = document.createElement('button');
      connectBtn.className = 'host-connect-btn';
      connectBtn.textContent = 'Connect';
      connectBtn.addEventListener('click', e => {
        e.stopPropagation();
        document.getElementById('hosts-overlay').classList.add('hidden');
        this._connectHost(host);
      });

      const editBtn = document.createElement('button');
      editBtn.className = 'host-action-btn';
      editBtn.title = 'Edit';
      editBtn.textContent = '✎';
      editBtn.addEventListener('click', e => {
        e.stopPropagation();
        document.getElementById('hosts-overlay').classList.add('hidden');
        this._showHostEditOverlay(host, async () => {
          document.getElementById('hosts-overlay').classList.remove('hidden');
          await this._renderHostList();
        });
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'host-action-btn host-delete-btn';
      deleteBtn.title = 'Delete';
      deleteBtn.textContent = '✕';
      deleteBtn.addEventListener('click', async e => {
        e.stopPropagation();
        await fetch(`/hosts/${host.id}`, { method: 'DELETE' });
        await this._renderHostList();
      });

      row.appendChild(name);
      row.appendChild(cmd);
      row.appendChild(connectBtn);
      row.appendChild(editBtn);
      row.appendChild(deleteBtn);
      list.appendChild(row);
    }
  }

  _connectHost(host) {
    const t = this.terms.get(this.activeId);
    this._send({
      type: 'new_window',
      label: host.name,
      color: '#7aa2f7',
      cols: t ? t.xterm.cols : 120,
      rows: t ? t.xterm.rows : 40,
      command: host.command,
    });
  }

  _showHostEditOverlay(existing, onDone) {
    const overlay   = document.getElementById('host-edit-overlay');
    const title     = document.getElementById('host-edit-title');
    const nameInput = document.getElementById('host-name-input');
    const cmdInput  = document.getElementById('host-cmd-input');
    const okBtn     = document.getElementById('host-edit-ok');
    const cancelBtn = document.getElementById('host-edit-cancel');

    title.textContent = existing ? 'Edit Host' : 'New Host';
    nameInput.value = existing ? existing.name    : '';
    cmdInput.value  = existing ? existing.command : 'ssh ';

    overlay.classList.remove('hidden');
    nameInput.focus();

    const cleanup = () => overlay.classList.add('hidden');

    const doSave = async () => {
      const name    = nameInput.value.trim();
      const command = cmdInput.value.trim();
      if (!name || !command) return;
      if (existing) {
        await fetch(`/hosts/${existing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, command }),
        });
      } else {
        await fetch('/hosts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, command }),
        });
      }
      cleanup();
      if (onDone) onDone();
    };

    okBtn.onclick     = doSave;
    cancelBtn.onclick = () => { cleanup(); if (onDone) onDone(); };
    nameInput.onkeydown = e => { if (e.key === 'Enter') cmdInput.focus(); if (e.key === 'Escape') { cleanup(); if (onDone) onDone(); } };
    cmdInput.onkeydown  = e => { if (e.key === 'Enter') doSave();         if (e.key === 'Escape') { cleanup(); if (onDone) onDone(); } };
    overlay.addEventListener('mousedown', e => {
      if (e.target === overlay) { cleanup(); if (onDone) onDone(); }
    }, { once: true });
  }

  // ── Settings ──────────────────────────────────────────────────────────

  _loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('smux-settings') || '{}');
      this.settings = {
        theme:    s.theme    || 'dark',
        fontSize: s.fontSize || 14,
        fontFace: s.fontFace || 'system',
      };
    } catch(_) {
      this.settings = { theme: 'dark', fontSize: 14, fontFace: 'system' };
    }
    this._applySettings();
  }

  _saveSettings() {
    localStorage.setItem('smux-settings', JSON.stringify(this.settings));
  }

  _applySettings() {
    const { theme, fontSize, fontFace } = this.settings;

    // Theme
    document.documentElement.setAttribute('data-theme', theme);

    // Xterm theme
    const xtTheme = theme === 'light' ? XTERM_THEME_LIGHT : XTERM_THEME;
    // Resolved font family
    const fontFamily = fontFace === 'system'
      ? '"SF Mono", "Fira Code", Menlo, Monaco, monospace'
      : `"${fontFace}", monospace`;

    this.terms.forEach(({ xterm, fit }) => {
      xterm.options.theme    = xtTheme;
      xterm.options.fontSize = fontSize;
      xterm.options.fontFamily = fontFamily;
      fit.fit();
      xterm.scrollToBottom();
    });
  }

  _showSettingsOverlay() {
    const overlay = document.getElementById('settings-overlay');
    const { theme, fontSize, fontFace } = this.settings;

    // Sync toggle buttons
    overlay.querySelectorAll('#theme-toggle .toggle-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.value === theme);
    });
    overlay.querySelectorAll('#font-size-row .toggle-btn').forEach(b => {
      b.classList.toggle('active', Number(b.dataset.value) === fontSize);
    });

    // Sync font select
    const sel = document.getElementById('font-face-select');
    sel.value = fontFace;

    overlay.classList.remove('hidden');

    // Theme toggle
    overlay.querySelectorAll('#theme-toggle .toggle-btn').forEach(b => {
      b.onclick = () => {
        overlay.querySelectorAll('#theme-toggle .toggle-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        this.settings.theme = b.dataset.value;
        this._applySettings();
        this._saveSettings();
      };
    });

    // Font size toggle
    overlay.querySelectorAll('#font-size-row .toggle-btn').forEach(b => {
      b.onclick = () => {
        overlay.querySelectorAll('#font-size-row .toggle-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        this.settings.fontSize = Number(b.dataset.value);
        this._applySettings();
        this._saveSettings();
      };
    });

    // Font face select
    sel.onchange = () => {
      this.settings.fontFace = sel.value;
      this._applySettings();
      this._saveSettings();
    };

    document.getElementById('settings-close').onclick = () => overlay.classList.add('hidden');
    overlay.addEventListener('mousedown', e => {
      if (e.target === overlay) overlay.classList.add('hidden');
    }, { once: true });
  }

  // ── UI init ───────────────────────────────────────────────────────────

  _initUI() {
    this._loadSettings();

    // Primary sidebar action buttons
    document.getElementById('btn-new-term-action').addEventListener('click', () => this._showNewTermDialog());
    document.getElementById('btn-new-group-action').addEventListener('click', () => this._showNewGroupDialog());

    // Tab bar new button
    document.getElementById('btn-new-tab').addEventListener('click', () => this._showNewTermDialog());

    // Footer buttons
    document.getElementById('btn-search-all').addEventListener('click', () => this._showSearchOverlay());
    document.getElementById('btn-history').addEventListener('click', () => this._showHistoryOverlay());
    document.getElementById('btn-hosts').addEventListener('click', () => this._showHostsOverlay());
    document.getElementById('btn-snippets').addEventListener('click', () => this._showSnippetsOverlay());
    document.getElementById('btn-settings').addEventListener('click', () => this._showSettingsOverlay());

    // Clear button
    document.getElementById('btn-clear-term').addEventListener('click', () => {
      const t = this.terms.get(this.focusedId || this.activeId);
      if (t) t.xterm.clear();
    });

    // History overlay close / clear
    document.getElementById('history-close').addEventListener('click', () => {
      document.getElementById('history-overlay').classList.add('hidden');
    });
    document.getElementById('history-clear-btn').addEventListener('click', () => {
      this.historyLines = [];
      this._updateHistoryCounter();
      document.getElementById('history-overlay').classList.add('hidden');
    });
    document.getElementById('history-overlay').addEventListener('mousedown', e => {
      if (e.target === document.getElementById('history-overlay'))
        document.getElementById('history-overlay').classList.add('hidden');
    });

    // Sidebar resize
    const sidebarEl = document.getElementById('sidebar');
    const resizeHandle = document.getElementById('sidebar-resize-handle');
    resizeHandle.addEventListener('pointerdown', e => {
      e.preventDefault();
      resizeHandle.setPointerCapture(e.pointerId);
      resizeHandle.classList.add('dragging');
      const onMove = e => {
        const w = Math.min(400, Math.max(150, e.clientX));
        sidebarEl.style.width = w + 'px';
        this._renderTermContainer();
      };
      const onUp = () => {
        resizeHandle.classList.remove('dragging');
        resizeHandle.removeEventListener('pointermove', onMove);
        resizeHandle.removeEventListener('pointerup', onUp);
      };
      resizeHandle.addEventListener('pointermove', onMove);
      resizeHandle.addEventListener('pointerup', onUp);
    });

    // Dismiss context menu on any click
    document.addEventListener('mousedown', e => {
      if (!e.target.closest('#ctx-menu')) this._hideContextMenu();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') this._hideContextMenu();
    });

    // ResizeObserver keeps active terminal fitted
    const ro = new ResizeObserver(() => {
      this._renderTermContainer();
    });
    ro.observe(document.getElementById('term-container'));

    // Keyboard shortcuts
    const overlayIds = ['search-overlay','label-overlay','group-overlay','new-term-overlay','settings-overlay','snippets-overlay','snippet-edit-overlay','history-overlay','hosts-overlay','host-edit-overlay'];
    document.addEventListener('keydown', e => {
      if (overlayIds.some(id => !document.getElementById(id).classList.contains('hidden'))) return;

      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === 't')  { e.preventDefault(); this._showNewTermDialog(); return; }
      if (meta && e.key === 'w')  { e.preventDefault(); if (this.activeId) this._send({ type: 'close_window', windowId: this.activeId }); return; }
      if (meta && e.key === 'f')  { e.preventDefault(); this._showSearchOverlay(); return; }
      if (meta && e.key === ',')  { e.preventDefault(); this._showSettingsOverlay(); return; }
      if (meta && e.key === ']')  { e.preventDefault(); this._cycleTab(1); return; }
      if (meta && e.key === '[')  { e.preventDefault(); this._cycleTab(-1); return; }
      if (meta && e.key === 'k')  { e.preventDefault(); const t = this.terms.get(this.focusedId || this.activeId); if (t) t.xterm.clear(); return; }
    });
  }

  _cycleTab(dir) {
    if (!this.windows.length) return;
    const idx = this.windows.findIndex(w => w.id === this.activeId);
    const next = (idx + dir + this.windows.length) % this.windows.length;
    this._activate(this.windows[next].id);
  }
}

// Boot
window.addEventListener('DOMContentLoaded', () => { window._app = new SmuxApp(); });
