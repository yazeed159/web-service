// global-search.js — full-text search across every published trade's
// verdict/lessons/walk-away rule/better-entry-exit reasoning/symbol
// description. Used to be its own sidebar tab + page (notes.html); now
// it's a search icon in the topbar of every page that opens this modal,
// so the sidebar doesn't need a dedicated entry for it. The indexing
// logic below is the same as notes.html's -- just wired to modal ids
// instead of a full page.
(function () {
  "use strict";

  if (/\/login(\.html)?\/?$/.test(window.location.pathname)) return;
  const topbarRight = document.querySelector(".topbar-right");
  if (!topbarRight) return;

  const INDEX_CACHE_PREFIX = "trade.log:notesIndex:";
  const CONCURRENCY = 6;

  // ---- inject the topbar trigger button --------------------------------
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "icon-btn icon-btn-visible";
  trigger.id = "gs-open-btn";
  trigger.title = "Search notes";
  trigger.setAttribute("aria-label", "Search notes");
  trigger.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;
  const mobileBtn = document.getElementById("mobile-nav-btn");
  if (mobileBtn) topbarRight.insertBefore(trigger, mobileBtn);
  else topbarRight.appendChild(trigger);

  // ---- build the modal ---------------------------------------------------
  const overlay = document.createElement("div");
  overlay.className = "gs-modal-overlay";
  overlay.id = "gs-modal-overlay";
  overlay.innerHTML = `
    <div class="gs-modal-box" role="dialog" aria-modal="true" aria-label="Search notes">
      <div class="gs-modal-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
        <input type="text" id="gs-query" class="gs-modal-input" placeholder="Search notes… e.g. “chased”, “vwap”, “too early”">
        <button type="button" class="gs-modal-close" id="gs-close-btn" title="Close" aria-label="Close search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      <div class="gs-modal-filters">
        <label title="Search verdict text"><input type="checkbox" id="gs-f-verdict" checked> Verdict</label>
        <label title="Search each trade's logged lessons"><input type="checkbox" id="gs-f-lessons" checked> Lessons</label>
        <label title="Search the walk-away rule text"><input type="checkbox" id="gs-f-walkaway" checked> Walk-away rule</label>
        <label title="Search the AI's better-entry/exit reasoning"><input type="checkbox" id="gs-f-better" checked> Better entry/exit reasons</label>
        <label title="Search the symbol's About/description text"><input type="checkbox" id="gs-f-symbol" checked> Symbol info</label>
      </div>
      <div class="gs-modal-status" id="gs-status"></div>
      <div class="gs-modal-results" id="gs-results">
        <div class="empty-state">Type above to search every trade's notes.</div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const queryEl = document.getElementById("gs-query");
  const statusEl = document.getElementById("gs-status");
  const resultsEl = document.getElementById("gs-results");
  const fieldToggles = {
    verdict: document.getElementById("gs-f-verdict"),
    lessons: document.getElementById("gs-f-lessons"),
    walkaway: document.getElementById("gs-f-walkaway"),
    better: document.getElementById("gs-f-better"),
    symbol: document.getElementById("gs-f-symbol"),
  };

  let index = [];
  let indexReady = false;
  let indexBuildStarted = false;
  let indexFailed = 0;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtMoney(v) {
    const sign = v >= 0 ? "+" : "-";
    return sign + "$" + Math.abs(v).toFixed(2);
  }

  function extractFields(detail) {
    return {
      verdict: detail.verdict || "",
      lessons: Array.isArray(detail.lessons) ? detail.lessons.join(" \n ") : "",
      walkaway: detail.walk_away_rule || "",
      better: [detail.better_entry && detail.better_entry.reason, detail.better_exit && detail.better_exit.reason].filter(Boolean).join(" \n "),
      symbol: (detail.symbol_info && detail.symbol_info.description) || "",
    };
  }

  function cacheKey(rows) {
    const last = rows[rows.length - 1];
    return INDEX_CACHE_PREFIX + rows.length + ":" + (last ? last.id : "none");
  }

  async function fetchAll(rows, onProgress) {
    const out = new Array(rows.length);
    let next = 0, done = 0;
    async function worker() {
      while (next < rows.length) {
        const i = next++;
        const row = rows[i];
        try {
          const detail = await window.fetchTradeDetail(row.id);
          if (!detail) throw new Error("Trade not found");
          out[i] = { id: row.id, symbol: row.symbol, trade_date: row.trade_date, win: row.win, pnl_after_comm: row.pnl_after_comm, fields: extractFields(detail) };
        } catch (e) {
          indexFailed++;
          out[i] = null;
        }
        done++;
        onProgress(done, rows.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
    return out.filter(Boolean);
  }

  function buildIndex() {
    if (indexBuildStarted) return;
    indexBuildStarted = true;
    statusEl.textContent = "Loading trade index…";
    window.fetchTradesIndex()
      .then(async (rows) => {
        rows = Array.isArray(rows) ? rows : [];
        if (!rows.length) {
          statusEl.textContent = "";
          resultsEl.innerHTML = `<div class="empty-state">No trades published yet.</div>`;
          return;
        }
        const key = cacheKey(rows);
        let cached = null;
        try { cached = JSON.parse(sessionStorage.getItem(key) || "null"); } catch (e) { cached = null; }
        if (cached && Array.isArray(cached)) {
          index = cached;
          indexReady = true;
          statusEl.textContent = `Indexed ${index.length} trade${index.length === 1 ? "" : "s"}' notes (cached this session).`;
          render(queryEl.value);
          return;
        }
        indexFailed = 0;
        index = await fetchAll(rows, (done, total) => {
          statusEl.textContent = `Indexing trade notes… ${done}/${total}`;
        });
        indexReady = true;
        try { sessionStorage.setItem(key, JSON.stringify(index)); } catch (e) { /* dataset too big -- skip caching */ }
        statusEl.textContent = `Indexed ${index.length} trade${index.length === 1 ? "" : "s"}' notes${indexFailed ? ` (${indexFailed} detail file${indexFailed === 1 ? "" : "s"} couldn't be loaded — skipped)` : ""}.`;
        render(queryEl.value);
      })
      .catch((err) => {
        statusEl.textContent = "";
        resultsEl.innerHTML = `<div class="empty-state">Couldn't load your trades (${escapeHtml(String(err.message))}).</div>`;
      });
  }

  function snippet(text, q, pad) {
    const lower = text.toLowerCase();
    const at = lower.indexOf(q.toLowerCase());
    if (at === -1) return "";
    const start = Math.max(0, at - pad);
    const end = Math.min(text.length, at + q.length + pad);
    const before = escapeHtml(text.slice(start, at));
    const match = escapeHtml(text.slice(at, at + q.length));
    const after = escapeHtml(text.slice(at + q.length, end));
    return `${start > 0 ? "…" : ""}${before}<mark>${match}</mark>${after}${end < text.length ? "…" : ""}`;
  }

  const FIELD_LABELS = { verdict: "Verdict", lessons: "Lessons", walkaway: "Walk-away rule", better: "Better entry/exit reason", symbol: "Symbol info" };

  function search(q) {
    const activeFields = Object.keys(fieldToggles).filter((k) => fieldToggles[k].checked);
    const lowerQ = q.toLowerCase();
    const matches = [];
    for (const row of index) {
      for (const key of activeFields) {
        const text = row.fields[key];
        if (text && text.toLowerCase().includes(lowerQ)) {
          matches.push({ row, field: key, snippet: snippet(text, q, 60) });
        }
      }
    }
    return matches;
  }

  function render(q) {
    if (!indexReady) return;
    if (!q.trim()) {
      resultsEl.innerHTML = `<div class="empty-state">Type above to search every trade's notes.</div>`;
      return;
    }
    const matches = search(q.trim());
    if (!matches.length) {
      resultsEl.innerHTML = `<div class="empty-state">No matches for “${escapeHtml(q.trim())}”.</div>`;
      return;
    }
    const tradeCount = new Set(matches.map((m) => m.row.id)).size;
    resultsEl.innerHTML = `
      <p style="color:var(--text-faint); font-size:12.5px; margin:0 0 10px;">${matches.length} match${matches.length === 1 ? "" : "es"} across ${tradeCount} trade${tradeCount === 1 ? "" : "s"}</p>
      <div class="panel-box" style="padding:0;">
        <div class="table-scroll">
          ${matches.map((m) => `
            <a class="row-link" href="trade.html?id=${encodeURIComponent(m.row.id)}" style="display:flex; flex-direction:column; gap:4px; padding:10px 12px; border-bottom:1px solid var(--border-soft); color:var(--text); text-decoration:none;">
              <div style="display:flex; align-items:center; gap:8px; font-size:12.5px;">
                <b>${escapeHtml(m.row.symbol)}</b>
                <span style="color:var(--text-faint);">${escapeHtml(m.row.trade_date)}</span>
                <span class="pill ${m.row.win ? "win" : "loss"}">${m.row.win ? "WIN" : "LOSS"}</span>
                <span class="${m.row.pnl_after_comm >= 0 ? "up" : "down"}">${fmtMoney(m.row.pnl_after_comm)}</span>
                <span class="pill" style="margin-left:auto;">${escapeHtml(FIELD_LABELS[m.field])}</span>
              </div>
              <div style="font-size:13px; color:var(--text-dim); line-height:1.5;">${m.snippet}</div>
            </a>
          `).join("")}
        </div>
      </div>
    `;
  }

  let debounceTimer = null;
  queryEl.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => render(queryEl.value), 150);
  });
  Object.values(fieldToggles).forEach((el) => el.addEventListener("change", () => render(queryEl.value)));

  // ---- open/close wiring -------------------------------------------------
  function openModal() {
    overlay.classList.add("open");
    buildIndex();
    setTimeout(() => queryEl.focus(), 10);
  }
  function closeModal() { overlay.classList.remove("open"); }

  trigger.addEventListener("click", openModal);
  document.getElementById("gs-close-btn").addEventListener("click", closeModal);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("open")) { closeModal(); return; }
    // "/" opens search from anywhere, same as most sites -- unless the
    // person is already typing in some other field.
    if (e.key === "/" && !overlay.classList.contains("open")) {
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement.isContentEditable) return;
      e.preventDefault();
      openModal();
    }
  });
})();
