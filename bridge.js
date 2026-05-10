/**
 * bridge.js — browser-based message broker replacing the Electron main process.
 *
 * Replaces: ipcMain / ipcRenderer  →  BroadcastChannel("tas-bridge")
 * Replaces: zlib (Node)            →  DecompressionStream / CompressionStream (Web)
 * Replaces: window.open (Electron) →  window.open (browser popup)
 *
 * Both the game page and the TAS-tool page load this file.
 * Each side listens for messages addressed to it and dispatches callbacks.
 *
 * Message envelope:
 *   { type: string, payload: any }
 *
 * Message types (mirrors the Electron IPC channel names):
 *   GAME → TAS:
 *     "tas-tool-set-recording"   payload: encoded string
 *     "tas-tool-ghosts-update"   payload: ghosts object
 *     "tas-tool-set-visibility"  payload: boolean[]
 *     "tas-tool-request-load"    payload: index number
 *     "tas-tool-encoded-update"  payload: encoded string
 *   TAS → GAME:
 *     "tas-tool-apply"           payload: human-readable text
 *     "tas-tool-set-ghosts"      payload: ghosts object (echoed back to TAS)
 *     "tas-tool-set-visibility"  payload: boolean[]
 *     "tas-tool-request-load"    payload: index
 *     "tas-tool-history-update"  payload: { history, historyIndex }
 *
 * File I/O (previously Electron dialog + fs):
 *   Bridge exposes tasToolSaveToFile / tasToolLoadFromFile using
 *   showSaveFilePicker / showOpenFilePicker (File System Access API)
 *   with a <input type=file> / <a download> fallback for unsupported browsers.
 */

(function (global) {
  "use strict";

  /* ─────────────────────────────────────────────
     1.  Low-level BroadcastChannel bus
  ───────────────────────────────────────────── */
  const CHANNEL_NAME = "tas-bridge";
  let _channel = null;
  const _listeners = {}; // type → [fn, ...]

  function getChannel() {
    if (!_channel) {
      _channel = new BroadcastChannel(CHANNEL_NAME);
      _channel.onmessage = function (evt) {
        const { type, payload } = evt.data || {};
        if (!type) return;
        (_listeners[type] || []).forEach(function (fn) {
          try { fn(payload); } catch (e) { console.warn("[bridge] listener error", e); }
        });
      };
    }
    return _channel;
  }

  function send(type, payload) {
    try { getChannel().postMessage({ type, payload }); } catch (e) {}
  }

  function on(type, fn) {
    if (!_listeners[type]) _listeners[type] = [];
    _listeners[type].push(fn);
  }

  function off(type, fn) {
    if (!_listeners[type]) return;
    _listeners[type] = _listeners[type].filter(function (f) { return f !== fn; });
  }

  /* ─────────────────────────────────────────────
     2.  TAS encode / decode / format
         (Port of main.js Node/zlib logic → browser streams)
  ───────────────────────────────────────────── */

  /**
   * Base64url → Uint8Array
   */
  function base64urlToBytes(str) {
    let s = str.replace(/-/g, "+").replace(/_/g, "/");
    const pad = s.length % 4;
    if (pad) s += "=".repeat(4 - pad);
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * Uint8Array → base64url (no padding)
   */
  function bytesToBase64url(buf) {
    let bin = "";
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }

  /**
   * inflate (zlib/deflate) via DecompressionStream
   * Returns Promise<Uint8Array>
   */
  async function inflate(compressedBytes) {
    const ds = new DecompressionStream("deflate");
    const writer = ds.writable.getWriter();
    writer.write(compressedBytes);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    let totalLen = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLen += value.length;
    }
    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }

  /**
   * deflate via CompressionStream
   * Returns Promise<Uint8Array>
   */
  async function deflate(rawBytes) {
    const cs = new CompressionStream("deflate");
    const writer = cs.writable.getWriter();
    writer.write(rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes));
    writer.close();
    const reader = cs.readable.getReader();
    const chunks = [];
    let totalLen = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLen += value.length;
    }
    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }

  /**
   * Read a 3-byte little-endian uint from a Uint8Array at pos.
   */
  function readUInt24LE(a, pos) {
    return a[pos] | (a[pos + 1] << 8) | (a[pos + 2] << 16);
  }

  /**
   * Write a 3-byte little-endian uint into a Uint8Array at pos.
   */
  function writeUInt24LE(a, pos, val) {
    a[pos]     = val & 0xff;
    a[pos + 1] = (val >> 8) & 0xff;
    a[pos + 2] = (val >> 16) & 0xff;
  }

  /**
   * Decode a TAS recording from its base64url-encoded form.
   * Returns Promise<{up, right, down, left, reset}> or null on failure.
   */
  async function decodeTasRecording(encoded) {
    try {
      if (typeof encoded !== "string" || !encoded) return null;
      const compressed = base64urlToBytes(encoded);
      const a = await inflate(compressed);
      let s = 0;
      function readArray() {
        if (s + 3 > a.length) return null;
        const len = readUInt24LE(a, s); s += 3;
        const arr = new Array(len);
        let prev = 0;
        for (let i = 0; i < len; i++) {
          if (s + 3 > a.length) return null;
          const delta = readUInt24LE(a, s); s += 3;
          prev = i === 0 ? delta : prev + delta;
          arr[i] = prev;
        }
        return arr;
      }
      const up    = readArray(); if (up    == null) return null;
      const right = readArray(); if (right == null) return null;
      const down  = readArray(); if (down  == null) return null;
      const left  = readArray(); if (left  == null) return null;
      const reset = readArray(); if (reset == null) return null;
      return { up, right, down, left, reset };
    } catch (e) { return null; }
  }

  /**
   * Encode a TAS recording object into base64url.
   * Returns Promise<string|null>.
   */
  async function encodeTasRecording(rec) {
    try {
      if (!rec) return null;
      const keys = ["up", "right", "down", "left", "reset"];
      const parts = [];
      for (const k of keys) {
        const arr = rec[k] || [];
        const buf = new Uint8Array(3 + 3 * arr.length);
        writeUInt24LE(buf, 0, arr.length);
        let prev = 0;
        for (let i = 0; i < arr.length; i++) {
          const delta = arr[i] - prev;
          writeUInt24LE(buf, 3 + 3 * i, delta);
          prev = arr[i];
        }
        parts.push(buf);
      }
      // concatenate
      let totalLen = 0;
      for (const p of parts) totalLen += p.length;
      const raw = new Uint8Array(totalLen);
      let offset = 0;
      for (const p of parts) { raw.set(p, offset); offset += p.length; }
      const compressed = await deflate(raw);
      return bytesToBase64url(compressed);
    } catch (e) { console.error("[bridge] encodeTasRecording", e); return null; }
  }

  /**
   * Convert decoded recording → human-readable text (same as formatTasHuman in main.js).
   */
  function formatTasHuman(rec) {
    try {
      if (!rec) return "";
      const order  = ["up", "left", "down", "right"];
      const keyMap = { up: "w", left: "a", down: "s", right: "d" };
      const sets   = {};
      const allFrames = new Set();
      for (const dir of order) {
        sets[dir] = new Set(rec[dir] || []);
        for (const f of rec[dir] || []) allFrames.add(f);
      }
      const frames = Array.from(allFrames).sort((a, b) => a - b);
      const held   = { up: false, left: false, down: false, right: false };
      const lines  = [];
      for (const frame of frames) {
        for (const dir of order) { if (sets[dir].has(frame)) held[dir] = !held[dir]; }
        let keys = "";
        for (const dir of order) { if (held[dir]) keys += keyMap[dir]; }
        lines.push(frame + "," + keys);
      }
      return lines.join("\n");
    } catch (e) { return ""; }
  }

  /**
   * Parse human-readable text → recording object (same as parseTasHuman in main.js).
   */
  function parseTasHuman(text) {
    try {
      const rawLines = text.split("\n").map(function (line) {
        const h = line.indexOf("#");
        return h >= 0 ? line.slice(0, h) : line;
      }).filter(function (l) { return l.trim() !== ""; });

      const entries = [];
      for (const line of rawLines) {
        const parts = line.split(",");
        if (parts.length !== 2) continue;
        const frame = parseInt(parts[0], 10);
        const keys  = parts[1].trim();
        if (isNaN(frame)) continue;
        entries.push({ frame, keys });
      }

      const keyMap = { w: "up", a: "left", s: "down", d: "right" };
      const rec    = { up: [], right: [], down: [], left: [], reset: [] };
      const held   = { up: false, left: false, down: false, right: false };
      let lastFrame = -1;

      for (const entry of entries) {
        if (entry.frame <= lastFrame) continue;
        const want = { up: false, left: false, down: false, right: false };
        for (const ch of entry.keys) {
          const dir = keyMap[ch];
          if (dir) want[dir] = true;
        }
        for (const dir in held) {
          if (held[dir] !== want[dir]) rec[dir].push(entry.frame);
        }
        Object.assign(held, want);
        lastFrame = entry.frame;
      }
      return rec;
    } catch (e) { console.error("[bridge] parseTasHuman", e); return null; }
  }

  /* ─────────────────────────────────────────────
     3.  File I/O helpers (replaces Electron dialog + fs)
  ───────────────────────────────────────────── */

  /**
   * Save text to a file.
   * Uses File System Access API if available, falls back to <a download>.
   * Returns Promise<{canceled: boolean, filePath?: string}>
   */
  async function tasToolSaveToFile(text) {
    const content = typeof text === "string" ? text : "";
    // Modern File System Access API
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: "tas-script.tas",
          types: [
            { description: "TAS Scripts", accept: { "text/plain": [".tas", ".txt"] } },
            { description: "All Files",   accept: { "text/plain": [".*"] } }
          ]
        });
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
        return { canceled: false, filePath: handle.name };
      } catch (e) {
        if (e && e.name === "AbortError") return { canceled: true };
        return { canceled: true, error: String(e && e.message || e) };
      }
    }
    // Fallback: <a download>
    try {
      const blob = new Blob([content], { type: "text/plain" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = "tas-script.tas";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return { canceled: false };
    } catch (e) {
      return { canceled: true, error: String(e && e.message || e) };
    }
  }

  /**
   * Load text from a file.
   * Uses File System Access API if available, falls back to <input type=file>.
   * Returns Promise<{canceled: boolean, filePath?: string, content?: string}>
   */
  async function tasToolLoadFromFile() {
    // Modern File System Access API
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [
            { description: "TAS Scripts", accept: { "text/plain": [".tas", ".txt"] } },
            { description: "All Files",   accept: { "text/plain": [".*"] } }
          ],
          multiple: false
        });
        const file    = await handle.getFile();
        const content = await file.text();
        return { canceled: false, filePath: file.name, content };
      } catch (e) {
        if (e && e.name === "AbortError") return { canceled: true };
        return { canceled: true, error: String(e && e.message || e) };
      }
    }
    // Fallback: hidden <input type=file>
    return new Promise(function (resolve) {
      const input    = document.createElement("input");
      input.type     = "file";
      input.accept   = ".tas,.txt,text/plain";
      input.style.display = "none";
      let resolved = false;
      input.onchange = function () {
        const file = input.files && input.files[0];
        if (!file) { if (!resolved) { resolved = true; resolve({ canceled: true }); } return; }
        const reader = new FileReader();
        reader.onload = function (e) {
          if (!resolved) {
            resolved = true;
            resolve({ canceled: false, filePath: file.name, content: e.target.result });
          }
        };
        reader.onerror = function () {
          if (!resolved) { resolved = true; resolve({ canceled: true, error: "Read error" }); }
        };
        reader.readAsText(file);
      };
      // Treat focus-return-without-change as cancel (heuristic, 300 ms)
      window.addEventListener("focus", function onFocus() {
        setTimeout(function () {
          if (!resolved && (!input.files || input.files.length === 0)) {
            resolved = true; resolve({ canceled: true });
          }
          window.removeEventListener("focus", onFocus);
        }, 300);
      }, { once: true });
      document.body.appendChild(input);
      input.click();
      setTimeout(function () { document.body.removeChild(input); }, 2000);
    });
  }

  /* ─────────────────────────────────────────────
     4.  Shared ghost-state cache
         (mirrors lastTasGhosts in main.js)
  ───────────────────────────────────────────── */

  let _ghosts = null;

  function mergeGhosts(existing, incoming) {
    if (!incoming || !Array.isArray(incoming.names)) return existing;
    const payload = Object.assign({}, incoming);
    if (existing && Array.isArray(existing.names) &&
        existing.names.length === incoming.names.length) {
      // Preserve visibility
      if (Array.isArray(existing.visibility)) {
        payload.visibility =
          Array.isArray(incoming.visibility) &&
          incoming.visibility.length === existing.visibility.length
            ? incoming.visibility : existing.visibility;
      }
      // Preserve colors
      if (Array.isArray(existing.colors) &&
          (!Array.isArray(incoming.colors) || incoming.colors.length !== existing.colors.length)) {
        payload.colors = existing.colors;
      }
      if (Array.isArray(existing.secondaryColors) &&
          (!Array.isArray(incoming.secondaryColors) || incoming.secondaryColors.length !== existing.secondaryColors.length)) {
        payload.secondaryColors = existing.secondaryColors;
      }
    }
    return payload;
  }

  /* ─────────────────────────────────────────────
     5.  Public API — exported as window.TASBridge
  ───────────────────────────────────────────── */

  const TASBridge = {
    // Raw bus (for advanced use)
    send,
    on,
    off,

    // Codec
    decodeTasRecording,
    encodeTasRecording,
    formatTasHuman,
    parseTasHuman,

    // File I/O
    tasToolSaveToFile,
    tasToolLoadFromFile,

    // Ghost cache (read-only from outside)
    getGhosts() { return _ghosts; },

    /**
     * Called by game-preload.js to install the window.electron shim on the
     * GAME side and open/manage the TAS tool popup.
     */
    installGameSide() {
      let tasWindow = null;
      let lastEncoded = null;
      let tasHistory = null;
      let tasHistoryIndex = -1;

      function openTasWindow() {
        if (!tasWindow || tasWindow.closed) {
          tasWindow = window.open(
            "tas-tool.html",
            "tas-tool",
            "width=1280,height=720,resizable=yes,menubar=no,toolbar=no,location=no,status=no"
          );
          if (!tasWindow) {
            alert("Popup blocked — please allow popups for this site to use the TAS Tool.");
            return;
          }
          // Give the new window time to load, then push current state
          tasWindow.addEventListener("load", function () {
            if (lastEncoded) {
              send("tas-tool-set-recording", lastEncoded);
            }
            if (_ghosts) {
              send("tas-tool-ghosts-update", _ghosts);
            }
            send("tas-tool-history-sync", { history: tasHistory, historyIndex: tasHistoryIndex });
          });
        } else {
          tasWindow.focus();
        }
      }

      // Listen for messages from the TAS tool window → forward to game
      on("tas-tool-apply", function (encoded) {
        try {
          const el = window;
          // Dispatch as a custom event the game can subscribe to
          el.dispatchEvent(new CustomEvent("tas-tool-apply", { detail: encoded }));
          // Also call through window.electron shim listeners
          (_applyListeners || []).forEach(function (fn) { try { fn(encoded); } catch (e) {} });
        } catch (e) {}
      });

      on("tas-tool-set-visibility", function (visArr) {
        try {
          window.dispatchEvent(new CustomEvent("tas-tool-set-visibility", { detail: visArr }));
          (_visListeners || []).forEach(function (fn) { try { fn(visArr); } catch (e) {} });
        } catch (e) {}
      });

      on("tas-tool-request-load", function (idx) {
        try {
          window.dispatchEvent(new CustomEvent("tas-tool-request-load", { detail: idx }));
          (_loadListeners || []).forEach(function (fn) { try { fn(idx); } catch (e) {} });
        } catch (e) {}
      });

      on("tas-tool-history-update", function (data) {
        if (data && Array.isArray(data.history)) {
          tasHistory = data.history;
          tasHistoryIndex = typeof data.historyIndex === "number" ? data.historyIndex : -1;
        }
      });

      // Listener arrays for window.electron callbacks
      const _applyListeners = [];
      const _visListeners   = [];
      const _loadListeners  = [];

      // window.electron shim — mirrors preload.js API
      const electron = {
        quit() { window.close(); },

        addFullscreenChangeListener(fn) {
          document.addEventListener("fullscreenchange", fn);
        },
        isFullscreen() { return !!document.fullscreenElement; },
        setFullscreen(val) {
          if (val && !document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {});
          } else if (!val && document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
          }
        },

        openTasTool() { openTasWindow(); },

        setTasRecording(rec) {
          try {
            const encoded = typeof rec === "string" ? rec
              : rec && rec.serialize ? rec.serialize() : "";
            lastEncoded = encoded;
            send("tas-tool-set-recording", encoded);
          } catch (e) {}
        },

        tasToolApply(text) {
          // Game side should not call apply outward; TAS tool calls it inward.
          // But keep for symmetry.
          send("tas-tool-apply", text);
        },

        onTasToolEncodedUpdate(fn) {
          on("tas-tool-encoded-update", fn);
        },

        onTasToolApply(fn) {
          _applyListeners.push(fn);
          on("tas-tool-apply", fn);
        },

        setTasGhosts(payload) {
          try {
            if (payload && Array.isArray(payload.names)) {
              _ghosts = mergeGhosts(_ghosts, payload);
              send("tas-tool-ghosts-update", _ghosts);
            }
          } catch (e) {}
        },

        onTasToolGhostsUpdate(fn) {
          on("tas-tool-ghosts-update", fn);
        },

        tasToolSetVisibility(visArr) {
          if (_ghosts) {
            _ghosts.visibility = Array.isArray(visArr) ? visArr : null;
            send("tas-tool-ghosts-update", _ghosts);
          }
          send("tas-tool-set-visibility", visArr);
        },

        onTasToolSetVisibility(fn) {
          _visListeners.push(fn);
          on("tas-tool-set-visibility", fn);
        },

        tasToolRequestLoad(idx) {
          send("tas-tool-request-load", idx);
        },

        onTasToolRequestLoad(fn) {
          _loadListeners.push(fn);
          on("tas-tool-request-load", fn);
        },

        tasToolHistoryUpdate(data) {
          send("tas-tool-history-update", data);
        },

        async tasToolSaveToFile(text) { return tasToolSaveToFile(text); },
        async tasToolLoadFromFile()   { return tasToolLoadFromFile(); }
      };

      global.electron = electron;
    },

    /**
     * Called by tas-tool.html to install the window.electron shim on the
     * TAS TOOL side.
     */
    installTasSide() {
      const electron = {
        // TAS tool does not need most game-side APIs but we expose a
        // compatible subset so no code changes are needed in tas-tool.html.

        tasToolSetVisibility(visArr) {
          // Update local ghost cache then echo back to game
          if (_ghosts) {
            _ghosts.visibility = Array.isArray(visArr) ? visArr : null;
          }
          send("tas-tool-set-visibility", visArr);
          // Echo updated ghosts back to THIS window so checkboxes reflect
          if (_ghosts) {
            const listeners = _listeners["tas-tool-ghosts-update"] || [];
            listeners.forEach(function (fn) { try { fn(_ghosts); } catch (e) {} });
          }
        },

        onTasToolGhostsUpdate(fn) {
          on("tas-tool-ghosts-update", fn);
        },

        tasToolApply(text) {
          // Parse, re-encode, send encoded update back to game
          (async function () {
            try {
              const rec     = parseTasHuman(text);
              if (!rec) return;
              const encoded = await encodeTasRecording(rec);
              if (!encoded) return;
              // Send human text to game for actual application
              send("tas-tool-apply", text);
              // Also update the encoded field in THIS window
              const listeners = _listeners["tas-tool-encoded-update"] || [];
              listeners.forEach(function (fn) { try { fn(encoded); } catch (e) {} });
            } catch (e) { console.error("[bridge] tasToolApply", e); }
          })();
        },

        onTasToolEncodedUpdate(fn) {
          on("tas-tool-encoded-update", fn);
        },

        tasToolRequestLoad(idx) {
          send("tas-tool-request-load", idx);
        },

        onTasToolRequestLoad(fn) {
          on("tas-tool-request-load", fn);
        },

        tasToolHistoryUpdate(data) {
          send("tas-tool-history-update", data);
        },

        async tasToolSaveToFile(text) { return tasToolSaveToFile(text); },
        async tasToolLoadFromFile()   { return tasToolLoadFromFile(); }
      };

      // When the game pushes a new recording, decode and populate the editors
      on("tas-tool-set-recording", async function (encoded) {
        try {
          const rec   = await decodeTasRecording(encoded);
          const human = rec ? formatTasHuman(rec) : "";
          global.__tasEncoded = encoded || "";
          global.__tasDecoded = human;
          const encEl = document.getElementById("encoded");
          if (encEl) encEl.value = encoded || "";
          const decEl = document.getElementById("decoded");
          if (decEl) { decEl.value = human; decEl.textContent = human; }
          // Fire encoded-update listeners so the editor can react
          const listeners = _listeners["tas-tool-encoded-update"] || [];
          listeners.forEach(function (fn) { try { fn(encoded); } catch (e) {} });
        } catch (e) {}
      });

      // Ghost updates
      on("tas-tool-ghosts-update", function (payload) {
        _ghosts = mergeGhosts(_ghosts, payload);
      });

      // Visibility echoes from game
      on("tas-tool-set-visibility", function (visArr) {
        if (_ghosts) _ghosts.visibility = Array.isArray(visArr) ? visArr : null;
      });

      // History sync from game (on window open)
      on("tas-tool-history-sync", function (data) {
        if (data && Array.isArray(data.history)) {
          global.__tasHistory      = data.history;
          global.__tasHistoryIndex = typeof data.historyIndex === "number" ? data.historyIndex : -1;
        }
      });

      global.electron = electron;
    }
  };

  global.TASBridge = TASBridge;

})(window);
