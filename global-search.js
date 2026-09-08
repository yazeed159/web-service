// global-search.js — header search, docked under the topbar.
//
// This is a from-scratch implementation. The markup/behavior below is
// built entirely against the .gs-dock* class contract that already lives
// in common.css (see the "global-search.css" comment block there) --
// there was no prior global-search.js in the export this replaces, so
// there's no old behavior being preserved here on purpose. Two decisions
// worth flagging if this needs revisiting:
//
//   1. Search only runs on submit (Enter, or the button), never on every
//      keystroke. No debounce timer, no live dropdown-as-you-type.
//   2. The dock is a full-width sticky panel docked directly under the
//      topbar (.gs-dock, already styled in common.css) -- not a cramped
//      header input with a tiny flyout.
//
// Self-mounting: this file finds .topbar-right and .main on whatever
// page it's loaded from and injects both the trigger button and the
// dock into them. Nothing to add per-page beyond the <script> tag --
// no HTML changes needed elsewhere for a new page to pick this up.
(function () {
  "use strict";

  const topbarRight = document.querySelector(".topbar-right");
  const main = document.querySelector(".main");
  const topbar = document.querySelector(".main > .topbar");
  if (!topbarRight || !main || !topbar) return; // page doesn't have the shell this mounts into

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function fmtMoney(v) {
    if (v == null || !isFinite(v)) return "";
    return (v >= 0 ? "+$" : "-$") + Math.abs(v).toFixed(2);
  }

  // ---- mount: trigger button + dock ------------------------------------

  const SEARCH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;
  const CLOSE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "icon-btn icon-btn-visible";
  trigger.id = "gs-trigger";
  trigger.title = "Search (Ctrl/\u2318 K)";
  trigger.setAttribute("aria-label", "Search your trades");
  trigger.innerHTML = SEARCH_ICON;
  // Search reads best as the primary action in the corner -- goes first,
  // ahead of the mobile menu button/anything else already in there.
  topbarRight.insertBefore(trigger, topbarRight.firstChild);

  const dock = document.createElement("div");
  dock.className = "gs-dock";
  dock.id = "gs-dock";
  dock.innerHTML = `
    <div class="gs-dock-inner">
      <form class="gs-dock-row" id="gs-form" autocomplete="off">
        ${SEARCH_ICON}
        <input class="gs-dock-input" id="gs-input" type="search"
               placeholder="Search by symbol… then press Enter" aria-label="Search your trades">
        <button type="button" class="gs-dock-toggle" id="gs-notes-toggle" aria-pressed="false">Search notes too</button>
        <select class="gs-dock-sort" id="gs-sort" aria-label="Sort results">
          <option value="recent">Most recent</option>
          <option value="pnl">Best P&amp;L</option>
        </select>
        <button type="button" class="gs-dock-close" id="gs-close" title="Close" aria-label="Close search">${CLOSE_ICON}</button>
      </form>
      <div class="gs-dock-status" id="gs-status"></div>
      <div class="gs-dock-results" id="gs-results"></div>
    </div>
  `;
  // Sits between the topbar and .content -- both are already .main's
  // direct children, so this only ever needs one known anchor point.
  main.insertBefore(dock, topbar.nextSibling);

  const formEl = dock.querySelector("#gs-form");
  const inputEl = dock.querySelector("#gs-input");
  const notesToggle = dock.querySelector("#gs-notes-toggle");
  const sortEl = dock.querySelector("#gs-sort");
  const closeBtn = dock.querySelector("#gs-close");
  const statusEl = dock.querySelector("#gs-status");
  const resultsEl = dock.querySelector("#gs-results");

  // ---- data (fetched lazily, once, on first use) ------------------------

  let trades = null; // Array | null, from window.fetchTradesIndex()
  let tradesPromise = null;
  let notesById = null; // Map<trade_id, {verdict,lessons,walk_away_rule,better_entry,better_exit,symbol_info}> | null
  let notesPromise = null;
  let searchNotes = false;

  function loadTrades() {
    if (!tradesPromise) {
      tradesPromise = window.fetchTradesIndex().then((rows) => {
        trades = Array.isArray(rows) ? rows : [];
        return trades;
      });
    }
    return tradesPromise;
  }

  // Bulk-loads just the note-ish columns for every trade, once -- "lazily
  // indexed on first use" per common.css's comment. Never fetched unless
  // the person actually turns "Search notes too" on, since it's a second
  // full-table read the plain symbol search doesn't need.
  function loadNotes() {
    if (!notesPromise) {
      notesPromise = window.AUTH_READY.then((session) => {
        if (!session || !window.sb) { notesById = new Map(); return notesById; }
        return window.sb
          .from("trade_details")
          .select("trade_id,verdict,lessons,walk_away_rule,better_entry,better_exit,symbol_info")
          .then((res) => {
            notesById = new Map();
            (res.data || []).forEach((row) => notesById.set(row.trade_id, row));
            return notesById;
          });
      });
    }
    return notesPromise;
  }

  // ---- open / close -------------------------------------------------

  function openDock() {
    dock.classList.add("open");
    loadTrades().catch(() => {});
    // Focus after the open animation's first frame so mobile keyboards
    // don't fight the panel's own transform.
    requestAnimationFrame(() => inputEl.focus());
    document.addEventListener("keydown", onKeydown, true);
  }
  function closeDock() {
    dock.classList.remove("open");
    document.removeEventListener("keydown", onKeydown, true);
  }
  function toggleDock() {
    if (dock.classList.contains("open")) closeDock();
    else openDock();
  }

  trigger.addEventListener("click", toggleDock);
  closeBtn.addEventListener("click", closeDock);

  function onKeydown(ev) {
    if (ev.key === "Escape") { closeDock(); trigger.focus(); }
  }
  // Ctrl/Cmd+K opens from anywhere on the page, not just while the dock's
  // already open -- this one's global, so it's wired once, up top.
  document.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      openDock();
    }
  });

  notesToggle.addEventListener("click", () => {
    searchNotes = !searchNotes;
    notesToggle.setAttribute("aria-pressed", String(searchNotes));
    notesToggle.textContent = searchNotes ? "Searching notes too" : "Search notes too";
    if (searchNotes) {
      statusEl.textContent = "Indexing notes\u2026";
      loadNotes().then(() => {
        if (inputEl.value.trim()) runSearch();
        else statusEl.textContent = "";
      });
    } else if (inputEl.value.trim()) {
      runSearch();
    }
  });

  sortEl.addEventListener("change", () => { if (inputEl.value.trim()) runSearch(); });

  // ---- search, on submit only --------------------------------------

  formEl.addEventListener("submit", (ev) => {
    ev.preventDefault();
    runSearch();
  });

  function snippetFor(query, text) {
    if (!text) return null;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return null;
    const start = Math.max(0, idx - 40);
    const end = Math.min(text.length, idx + query.length + 60);
    const prefix = start > 0 ? "\u2026" : "";
    const suffix = end < text.length ? "\u2026" : "";
    return prefix + text.slice(start, end) + suffix;
  }

  // Escapes first, then matches on the escaped forms -- so this never has
  // to worry about a query containing HTML-special characters ending up
  // unescaped in the result.
  function highlight(text, query) {
    const escaped = escapeHtml(text || "");
    const escapedQuery = escapeHtml(query || "");
    if (!escapedQuery) return escaped;
    const re = new RegExp(escapeRegex(escapedQuery), "ig");
    return escaped.replace(re, (m) => `<mark>${m}</mark>`);
  }

  const NOTE_FIELDS = ["verdict", "lessons", "walk_away_rule", "better_entry", "better_exit"];

  function matchTrade(t, query, notes) {
    const q = query.toLowerCase();
    if ((t.symbol || "").toLowerCase().includes(q)) {
      return { snippet: t.setup_type || null, snippetIsNote: false };
    }
    if (!searchNotes) return null;
    if (!notes) return null;
    for (const field of NOTE_FIELDS) {
      const val = notes[field];
      if (typeof val === "string" && val.toLowerCase().includes(q)) {
        return { snippet: snippetFor(query, val), snippetIsNote: true };
      }
    }
    const info = notes.symbol_info;
    if (info && ((info.name || "").toLowerCase().includes(q) || (info.description || "").toLowerCase().includes(q))) {
      return { snippet: info.description ? snippetFor(query, info.description) : info.name, snippetIsNote: true };
    }
    return null;
  }

  const RESULT_LIMIT = 40;

  function runSearch() {
    const query = inputEl.value.trim();
    if (!query) { statusEl.textContent = ""; resultsEl.innerHTML = ""; return; }

    statusEl.textContent = "Searching\u2026";
    resultsEl.innerHTML = "";

    const notesReady = searchNotes ? loadNotes() : Promise.resolve(notesById);

    Promise.all([loadTrades(), notesReady])
      .then(([rows, notes]) => {
        const matches = [];
        for (const t of rows) {
          const hit = matchTrade(t, query, notes ? notes.get(t.id) : null);
          if (hit) matches.push({ trade: t, ...hit });
        }

        matches.sort((a, b) => {
          if (sortEl.value === "pnl") return (b.trade.pnl_after_comm || 0) - (a.trade.pnl_after_comm || 0);
          return (b.trade.trade_date + (b.trade.entry_time || "")).localeCompare(a.trade.trade_date + (a.trade.entry_time || ""));
        });

        if (!matches.length) {
          statusEl.textContent = `No trades match "${query}"${searchNotes ? "" : " -- try \u201cSearch notes too\u201d"}.`;
          resultsEl.innerHTML = "";
          return;
        }

        const shown = matches.slice(0, RESULT_LIMIT);
        statusEl.textContent = `${matches.length} match${matches.length === 1 ? "" : "es"}${matches.length > shown.length ? ` (showing first ${shown.length})` : ""}.`;

        resultsEl.innerHTML = shown.map(({ trade: t, snippet }) => {
          const snippetHtml = snippet
            ? `<span class="gs-snip">${highlight(snippet, query)}</span>`
            : `<span class="gs-snip dim">${escapeHtml(t.side || "")}</span>`;
          return `
            <a class="gs-dock-item" href="trade.html?id=${encodeURIComponent(t.id)}">
              <span class="gs-sym">${highlight(t.symbol || "", query)}</span>
              <span class="gs-date">${escapeHtml(t.trade_date || "")}</span>
              ${snippetHtml}
              <span class="gs-pnl ${(t.pnl_after_comm || 0) >= 0 ? "up" : "down"}">${fmtMoney(t.pnl_after_comm)}</span>
            </a>`;
        }).join("");
      })
      .catch((err) => {
        statusEl.textContent = "Couldn't search (" + String((err && err.message) || err) + ").";
      });
  }
})();
