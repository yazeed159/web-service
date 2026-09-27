// shortcuts-help.js — the "?" keyboard-shortcuts overlay.
//
// Keyboard shortcuts that only live in a person's muscle memory (or a
// help doc nobody opens) aren't really discoverable. This is the single
// surface for all of them: press "?" anywhere outside a text field and
// a small reference card lists what works on the current page.
//
// Universal shortcuts (Ctrl/Cmd+K, "/", Esc) are baked in below. A page
// with its own bindings (practice.html, rewind.html) can add rows by
// setting window.PAGE_SHORTCUTS *before or after* this script runs --
// read lazily at open-time, not at load-time, so load order doesn't
// matter:
//
//   window.PAGE_SHORTCUTS = {
//     heading: "Practice mode",
//     items: [{ keys: ["Y", "Enter"], label: "Confirm entry" }, ...],
//   };
//
// Loaded after global-search.js on every app-shell page (see the
// <script> tag order shared with it) -- self-mounts, nothing else to
// wire up per page.
(function () {
  "use strict";

  if (/\/login(\.html)?\/?$/.test(window.location.pathname)) return;

  const UNIVERSAL = [
    { keys: ["Ctrl", "K"], mac: ["\u2318", "K"], label: "Search trades or jump to a page" },
    { keys: ["/"], label: "Focus search" },
    { keys: ["Esc"], label: "Close a dialog, panel, or search" },
    { keys: ["?"], label: "Show this list" },
  ];

  const isMac = /Mac|iPhone|iPod|iPad/.test(navigator.platform || navigator.userAgent || "");
  function keyLabel(item) {
    return (isMac && item.mac ? item.mac : item.keys)
      .map((k) => `<kbd>${escapeHtml(k)}</kbd>`)
      .join(" ");
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  let overlay = null;

  function render() {
    const page = window.PAGE_SHORTCUTS;
    const pageRows = page && Array.isArray(page.items) ? page.items : [];
    const rows = (items) => items.map((it) => `
      <div class="shortcuts-row">
        <span class="shortcuts-keys">${keyLabel(it)}</span>
        <span class="shortcuts-label">${escapeHtml(it.label)}</span>
      </div>`).join("");

    overlay = document.createElement("div");
    overlay.className = "shortcuts-overlay";
    overlay.innerHTML = `
      <div class="shortcuts-box" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div class="shortcuts-title">Keyboard shortcuts</div>
        <div class="shortcuts-section-label">Everywhere</div>
        ${rows(UNIVERSAL)}
        ${pageRows.length ? `<div class="shortcuts-section-label">${escapeHtml(page.heading || "This page")}</div>${rows(pageRows)}` : ""}
        <div class="shortcuts-actions">
          <button type="button" class="btn-confirm" data-act="close">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("open"));
    overlay.querySelector('[data-act="close"]').addEventListener("click", close);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove("open");
    const el = overlay;
    overlay = null;
    setTimeout(() => el.remove(), 160);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay) { close(); return; }
    if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(document.activeElement)) return;
    if (overlay) { close(); return; }
    render();
  });
})();
