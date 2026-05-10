/**
 * game-preload.js
 * ───────────────────────────────────────────────────────────────────────────
 * Drop this into the game's HTML page (before main_bundle.js) to replace the
 * Electron preload.js / main.js IPC bridge with a pure-browser equivalent.
 *
 * Load order in your HTML:
 *   <script src="bridge.js"></script>        ← shared codec + BroadcastChannel
 *   <script src="game-preload.js"></script>  ← installs window.electron shim
 *   <script src="main_bundle.js"></script>   ← game code (unchanged)
 *
 * The TAS tool popup (tas-tool.html) loads bridge.js on its own and calls
 * TASBridge.installTasSide() — see the <script> block at the bottom of
 * tas-tool.html.
 *
 * Key behavioural differences vs Electron:
 *  • window.open() is used instead of BrowserWindow — popups must be allowed.
 *  • Fullscreen uses the standard Fullscreen API (F11 is handled natively by
 *    browsers, so the F11/Alt+Enter shortcut is a no-op here).
 *  • File save/load uses File System Access API with a <a download> fallback.
 *  • quit() calls window.close() (only works if the page was opened by script).
 */

(function () {
  "use strict";

  if (typeof TASBridge === "undefined") {
    console.error("[game-preload] bridge.js must be loaded before game-preload.js");
    return;
  }

  // Install window.electron shim (populates global.electron)
  TASBridge.installGameSide();

  /* ─────────────────────────────────────────────────────────────────────────
     Fullscreen keyboard shortcut shim (F11 / Alt+Enter)
     Browsers intercept F11 natively, but we wire it up anyway for
     environments that forward it (e.g. Electron lite wrappers, PWA kiosks).
  ───────────────────────────────────────────────────────────────────────── */
  window.addEventListener("keydown", function (e) {
    if (e.isAutoRepeat || e.repeat) return;
    const isF11     = e.code === "F11";
    const isAltEnter = e.altKey && e.code === "Enter";
    if (isF11 || isAltEnter) {
      e.preventDefault();
      const isFS = !!document.fullscreenElement;
      if (isFS) {
        document.exitFullscreen().catch(() => {});
      } else {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    }
  });

  /* ─────────────────────────────────────────────────────────────────────────
     EnableTas keybind hook — mirrors the preload.js logic exactly.
     Reads the user's localStorage keybind for 'EnableTas' and dispatches the
     matching KeyboardEvent when the #enable-tas-button is clicked.
  ───────────────────────────────────────────────────────────────────────── */
  window.addEventListener("DOMContentLoaded", function () {
    function getEnableTasCode() {
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k) continue;
          const raw = localStorage.getItem(k);
          if (!raw) continue;
          let parsed;
          try { parsed = JSON.parse(raw); } catch { continue; }
          if (!Array.isArray(parsed)) continue;
          for (const entry of parsed) {
            if (!Array.isArray(entry) || entry.length !== 2) continue;
            const [action, bindings] = entry;
            if (action === "EnableTas" && Array.isArray(bindings)) {
              const [primary, secondary] = bindings;
              if (typeof primary   === "string" && primary)   return primary;
              if (typeof secondary === "string" && secondary) return secondary;
            }
          }
        }
      } catch { /* no-op */ }
      return null;
    }

    function triggerTasKey() {
      try {
        const code = getEnableTasCode();
        if (!code) return;
        window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true }));
      } catch { /* no-op */ }
    }

    // Delegate — handles dynamically-created button
    document.addEventListener("click", function (e) {
      if (e.target && e.target.id === "enable-tas-button") {
        triggerTasKey();
      }
    }, true);
  });

})();
