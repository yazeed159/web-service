(function () {
  "use strict";
  const R = (App.reports = App.reports || {});

  // ----------------------------------------------------------------
  // Drill-down. Click any stat, bar, table row or chart point in Reports
  // and a panel opens with the trades behind it: summary numbers, a
  // mini equity curve, "what's driving this" chips (symbol / setup /
  // weekday / winners / losers) and the sortable trade list. Every
  // trade links through to trade.html.
  //
  // How a renderer opts in: put `${drillAttr(title, trades)}` inside the
  // opening tag of the element (it adds data-drill + tabindex). The
  // trades are parked in drillRegistry, which renderReports() empties
  // at the start of each pass, so it never outlives the render that
  // filled it. One delegated click/keydown listener on #tab-reports
  // (bottom of this block) opens the panel -- renderers bind nothing.
  // Empty trade lists return "" so nothing is clickable that has
  // nothing behind it.
  // ----------------------------------------------------------------
  const drillRegistry = new Map(); // id -> { title, sub, trades }
  let drillSeq = 0;
  function drillAttr(title, trades, opts) {
    if (!trades || !trades.length) return "";
    opts = opts || {};
    // Only keep a drill-down when it shows something the page doesn't already:
    // a subset of the trades, or the working behind a number. A list of
    // every trade in view with no working is just the Journal again.
    if (!opts.calc && !opts.note && trades.length === (App.state.trades || []).length) return "";
    const id = "d" + drillSeq++;
    if (!opts.focus) {
      const hint = String(opts.sub || "") + " " + String(title);
      if (/commission flips/i.test(hint)) opts = { ...opts, focus: "flip" };
      else if (/hold/i.test(hint)) opts = { ...opts, focus: "hold" };
      else if (/position size/i.test(hint)) opts = { ...opts, focus: "size" };
      else if (/entry time/i.test(hint)) opts = { ...opts, focus: "entry" };
    }
    drillRegistry.set(id, {
      title: String(title), sub: opts.sub || "", trades,
      focus: opts.focus || "",        // "hold" | "comm" | "share" | "size" | "entry" | "flip": what this stat is about -- decides which columns the list shows
      calc: opts.calc || null,        // [[label, value], ...] -- how the number was made, from these trades
      note: opts.note || "",          // one plain-language line about what the number means
      collapse: Boolean(opts.collapse), // whole-history stats: show the working first, trade list on request
      order: opts.order || "",        // "chrono" for streaks (a run is read oldest -> newest)
    });
    return ` data-drill="${id}"${opts.row ? "" : ' role="button"'} tabindex="0"`;
  }
  // Some labels are built as HTML (e.g. "Net P&amp;L"); the panel title is
  // plain text that it escapes itself, so undo that first.
  function unescHtml(str) {
    return String(str).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  }
  // Clicking a drillable thing drops the trades behind it open right under it
  // as a plain table (same look as the other report tables) -- click again,
  // or the x, to fold it back up. Things with no trades behind them never get
  // data-drill (drillAttr returns "" for an empty list), so they don't react.
  const DRILL_PAGE = 5; // lists open on 5 trades; the buttons add 5 or 20 more
  const drillNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const drillStamp = (t) => `${t.trade_date || ""} ${t.entry_time || ""}`;
  const drillNewestFirst = (a, b) => drillStamp(b).localeCompare(drillStamp(a));
  // One column spec per field. `opt` columns are the ones a phone hides -- except the column the
  // clicked stat is actually about (its `focus`), which always stays so hold-time / commission /
  // per-share stats show the thing they are measuring instead of a generic P&L list.
  function drillPerShare(t) { return Number(t.shares) > 0 ? drillNum(t.pnl_after_comm) / Number(t.shares) : null; }
  function drillValue(t, focus) {
    if (focus === "hold") return App.durationMinutes(t);
    if (focus === "comm") return Number(t.commission) || 0;
    if (focus === "share") return drillPerShare(t);
    if (focus === "flip") return Number(t.commission) || 0;
    if (focus === "size") return Number(t.shares) || 0;
    return null;
  }
  // ---- executions + commission split -------------------------------------------------------
  // A trade stores ONE commission total, not a per-side figure, so "commission in / out" is that
  // total split by shares across the entries and exits (an estimate, labelled as one).
  const fmtQty = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const drillUsd = (v) => (v == null || !Number.isFinite(v) ? "\u2014" : "$" + Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const drillPx = (v) => "$" + Number(v).toFixed(Number(v) < 1 ? 4 : 2);
  // Real commission split: the sync saves what the broker charged on the way in and on the way
  // out (trades.commission_in / commission_out). Older trades don't have it -> "no split".
  const drillHasSplit = (t) => t.commission_in != null && t.commission_out != null && Number.isFinite(Number(t.commission_in)) && Number.isFinite(Number(t.commission_out));
  // Every entry / exit execution of ONE trade with its own commission, from the saved fills
  // (fetched on demand: the trade list itself doesn't carry fills).
  function drillExecListHtml(d) {
    const fills = Array.isArray(d && d.fills) ? d.fills : [];
    const agg = new Map();
    const add = (kind, time, price, qty, comm) => {
      if (!time || price == null) return;
      const k = `${kind}|${time}|${Number(price).toFixed(4)}`;
      const cur = agg.get(k) || { kind, time: String(time), price: Number(price), qty: 0, comm: 0, hasComm: true };
      cur.qty += Number(qty) || 0;
      if (Number.isFinite(Number(comm))) cur.comm += Number(comm); else cur.hasComm = false;
      agg.set(k, cur);
    };
    fills.forEach((f) => { add("entry", f.entry_time, f.entry_price, f.qty, f.commission_entry); add("exit", f.exit_time, f.exit_price, f.qty, f.commission_exit); });
    const list = [...agg.values()].sort((x, y) => (x.time < y.time ? -1 : x.time > y.time ? 1 : x.kind === y.kind ? 0 : x.kind === "entry" ? -1 : 1));
    if (!list.length) return '<div class="drill-exec-list dim">No fill detail saved for this trade.</div>';
    const lines = list.map((x) => `<div class="drill-exec ${x.kind}"><span class="k">${x.kind === "entry" ? "Entry" : "Exit"}</span><span class="mono dim">${escapeHtml(x.time)}</span><span class="mono">${fmtQty(x.qty)} sh @ ${drillPx(x.price)}</span><span class="mono">${x.hasComm ? "$" + x.comm.toFixed(2) : "\u2014"}</span></div>`).join("");
    return `<div class="drill-exec-list"><div class="drill-exec head"><span></span><span>Time</span><span>Shares @ price</span><span>Commission</span></div>${lines}</div>`;
  }
  function toggleExec(btn) {
    const tr = btn.closest("tr");
    if (!tr) return;
    let row = tr.nextElementSibling;
    if (row && row.classList.contains("drill-exec-row")) { row.hidden = !row.hidden; btn.setAttribute("aria-expanded", String(!row.hidden)); return; }
    row = document.createElement("tr");
    row.className = "drill-exec-row";
    row.innerHTML = `<td colspan="${tr.cells.length}"><div class="drill-exec-list dim">Loading\u2026</div></td>`;
    tr.after(row);
    btn.setAttribute("aria-expanded", "true");
    const cell = row.firstChild;
    Promise.resolve(window.fetchTradeDetail ? window.fetchTradeDetail(btn.dataset.id) : null)
      .then((d) => { cell.innerHTML = drillExecListHtml(d); })
      .catch(() => { cell.innerHTML = '<div class="drill-exec-list dim">Couldn\u2019t load the fills.</div>'; });
  }
  function drillColumns(focus, trades) {
    const pnl = (t) => drillNum(t.pnl_after_comm);
    const sumNum = (ts, f) => ts.reduce((a, t) => a + (f(t) || 0), 0);
    const value = (t) => (Number(t.shares) > 0 && Number.isFinite(Number(t.entry_price)) ? Number(t.shares) * Number(t.entry_price) : null);
    const symLink = (t) => `<a href="trade.html?id=${encodeURIComponent(t.id)}" class="drill-sym">${escapeHtml(t.symbol || "?")}</a>`;
    const date = { label: "Date", cls: "mono", cell: (t) => escapeHtml(t.trade_date || "\u2014") };
    const sym = { label: "Symbol", cell: symLink };
    const symExec = { label: "Symbol", cell: (t) => {
      if (!drillHasSplit(t) || !(Number(t.fill_count) > 1)) return symLink(t);
      return `${symLink(t)}<button type="button" class="drill-exec-toggle" aria-expanded="false" data-id="${escapeHtml(t.id)}" title="Show every entry and exit">Entries &amp; exits <i aria-hidden="true">\u25be</i></button>`;
    } };
    const net = { label: "Net P&amp;L", cls: "mono num", cell: (t) => `<span class="${pnl(t) >= 0 ? "up" : "down"}">${fmtMoney(pnl(t))}</span>`, pnlCol: true };
    const shares = { label: "Shares", cls: "mono num", cell: (t) => (t.shares != null ? Number(t.shares).toLocaleString() : "\u2014"), foot: (ts) => fmtQty(sumNum(ts, (t) => Number(t.shares))) };
    const valueCol = { label: "Total value", cls: "mono num", cell: (t) => drillUsd(value(t)), foot: (ts) => drillUsd(sumNum(ts, value)) };
    const time = (key) => (t) => (typeof t[key] === "string" && t[key] ? t[key].slice(0, 8) : "\u2014");
    switch (focus) {
      case "comm": {
        const split = (trades || []).some(drillHasSplit);
        const cols = [date, split ? symExec : sym, shares, valueCol];
        if (split) {
          cols.push({ label: "Comm. in", cls: "mono num", cell: (t) => (drillHasSplit(t) ? "$" + Number(t.commission_in).toFixed(2) : "\u2014"), foot: (ts) => "$" + sumNum(ts.filter(drillHasSplit), (t) => Number(t.commission_in)).toFixed(2) });
          cols.push({ label: "Comm. out", cls: "mono num", cell: (t) => (drillHasSplit(t) ? "$" + Number(t.commission_out).toFixed(2) : "\u2014"), foot: (ts) => "$" + sumNum(ts.filter(drillHasSplit), (t) => Number(t.commission_out)).toFixed(2) });
        }
        cols.push({ label: "Total comm.", cls: "mono num", focus: true, cell: (t) => "$" + (Number(t.commission) || 0).toFixed(2), foot: (ts) => "$" + sumNum(ts, (t) => Number(t.commission)).toFixed(2) });
        return cols;
      }
      case "fees":
        return [date, sym, shares,
          { label: "Fees", cls: "mono num", focus: true, cell: (t) => "$" + (Number(t.fees) || 0).toFixed(2), foot: (ts) => "$" + sumNum(ts, (t) => Number(t.fees)).toFixed(2) }, net];
      case "flip":
        return [date, sym,
          { label: "Gross P&amp;L", cls: "mono num", cell: (t) => fmtMoney(pnl(t) + (Number(t.commission) || 0)) },
          { label: "Commission", cls: "mono num", focus: true, cell: (t) => "$" + (Number(t.commission) || 0).toFixed(2), foot: (ts) => "$" + sumNum(ts, (t) => Number(t.commission)).toFixed(2) }, net];
      case "hold":
        return [date, sym, { label: "In", cls: "mono", cell: time("entry_time") },
          { label: "Out", cls: "mono", cell: time("exit_time") },
          { label: "Hold", cls: "mono num", focus: true, cell: (t) => { const h = App.durationMinutes(t); return h != null ? App.fmtDurationPrecise(h) : "\u2014"; },
            foot: (ts) => { const v = ts.map(App.durationMinutes).filter((x) => x != null); return v.length ? "avg " + fmtDuration(v.reduce((a, b) => a + b, 0) / v.length) : ""; } }];
      case "share":
        return [date, sym, shares,
          { label: "Entry \u2192 exit", cls: "mono num", cell: (t) => `${fmtPrice(t.entry_price)} \u2192 ${fmtPrice(t.exit_price)}` },
          { label: "P&amp;L / share", cls: "mono num", focus: true, cell: (t) => { const v = drillPerShare(t); return v == null ? "\u2014" : fmtMoney(v); },
            foot: (ts) => { const v = ts.map(drillPerShare).filter((x) => x != null); return v.length ? "avg " + fmtMoney(v.reduce((a, b) => a + b, 0) / v.length) : ""; } }];
      case "size":
        return [date, sym, Object.assign({}, shares, { focus: true }), valueCol, net];
      case "entry":
        return [date, sym, { label: "Entry time", cls: "mono num", focus: true, cell: time("entry_time") }, net];
      default:
        return [date, sym, net]; // a plain "these are the trades" list: when, what, and what it made
    }
  }
  function drillSort(trades, entry) {
    const out = trades.slice();
    if (entry.order === "chrono") return out.sort((a, b) => drillStamp(a).localeCompare(drillStamp(b)));
    if (entry.focus) {
      // Sort by the thing the stat is about (longest hold / biggest commission / best per-share) first.
      const num = (t) => { const v = drillValue(t, entry.focus); return v == null ? -Infinity : v; };
      return out.sort((a, b) => num(b) - num(a) || drillNewestFirst(a, b));
    }
    return out.sort(drillNewestFirst);
  }
  function drillCalcHtml(entry) {
    const items = (entry.calc || []).filter((r) => r && r[1] != null && r[1] !== "");
    if (!items.length && !entry.note) return "";
    return `<div class="drill-calc">
      ${items.length ? `<div class="drill-calc-grid">${items.map(([k, v]) => `<div class="drill-calc-item"><span class="drill-calc-k">${escapeHtml(k)}</span><b class="drill-calc-v">${escapeHtml(v)}</b></div>`).join("")}</div>` : ""}
      ${entry.note ? `<div class="drill-calc-note">${escapeHtml(entry.note)}</div>` : ""}
    </div>`;
  }
  function drillTableHtml(entry, shown) {
    const trades = entry.trades;
    const cols = drillColumns(entry.focus, entry.trades);
    const sorted = drillSort(trades, entry);
    const net = sorted.reduce((sum, t) => sum + drillNum(t.pnl_after_comm), 0);
    const remaining = sorted.length - Math.min(shown, sorted.length);
    const th = (c) => `<th scope="col" class="${c.cls && /num/.test(c.cls) ? "num" : ""}${c.focus ? " drill-focus" : ""}"${/est\./.test(c.label) ? ' title="Commission is stored per trade, so in/out is split by shares"' : ""}>${c.label}</th>`;
    const td = (c, t) => `<td class="${c.cls || ""}${c.focus ? " drill-focus" : ""}" data-label="${c.label}">${c.cell(t)}</td>`;
    // Footer: trade count under Date+Symbol, a total for every column that has one, net P&L where shown.
    const foot = cols.map((c, i) => {
      if (i === 0) return `<td colspan="2">${sorted.length} trade${sorted.length === 1 ? "" : "s"}</td>`;
      if (i === 1) return "";
      const cls = `${c.cls && /num/.test(c.cls) ? "num " : ""}${c.focus ? "drill-focus" : ""}`;
      if (c.pnlCol) return `<td class="mono num ${net >= 0 ? "up" : "down"}" data-label="${c.label}">${fmtMoney(net)}</td>`;
      return `<td class="${cls}" data-label="${c.label}">${c.foot ? c.foot(sorted) : ""}</td>`;
    }).join("");
    const rows = sorted.slice(0, shown).map((t) => `<tr>${cols.map((c) => td(c, t)).join("")}</tr>`).join("");
    const more = remaining > 0
      ? `<div class="drill-more-wrap">${window.moreButtonsHtml("", remaining, sorted.length, "drill-more")}</div>`
      : "";
    const missing = entry.focus === "comm" && sorted.some(drillHasSplit) ? sorted.filter((t) => !drillHasSplit(t)).length : 0;
    const note = missing ? `<div class="drill-est-note">${missing} older trade${missing === 1 ? "" : "s"} only have the total \u2014 the in / out split is saved for trades synced after the update.</div>` : "";
    return `<div class="table-scroll"><table class="report-table drill-table no-stack"><thead><tr>${cols.map(th).join("")}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr>${foot}</tr></tfoot></table></div>${note}${more}`;
  }
  function paintDrillPanel(panel) {
    const d = panel._drill;
    const e = d.entry;
    const hidden = e.collapse && !d.revealed;
    const n = e.trades.length;
    panel.querySelector(".drill-inline-body").innerHTML = drillCalcHtml(e)
      + (hidden
        ? `<div class="drill-more-wrap drill-reveal-wrap"><button type="button" class="btn-load-more drill-reveal">Show the ${n} trade${n === 1 ? "" : "s"} this uses</button></div>`
        : drillTableHtml(e, d.shown));
  }
  function closeInline(el) {
    const panel = el && el._drillPanel;
    if (!panel) return;
    if (panel._drill.key && panel._drill.key._drillEl === el) panel._drill.key._drillEl = null;
    // Fold shut, then remove -- the state below is cleared straight away, so reopening
    // (or opening a sibling) while it is still folding behaves as if it were already gone.
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      panel.remove();
    } else {
      panel.classList.add("drill-closing");
      setTimeout(() => panel.remove(), 180);
    }
    el._drillPanel = null;
    el.setAttribute("aria-expanded", "false");
    el.classList.remove("drill-open");
  }
  function toggleInline(el, entry) {
    if (!el || !entry || !entry.trades || !entry.trades.length) return;
    if (el._drillPanel) {
      const same = el._drillPanel._drill.entry.title === entry.title;
      closeInline(el);
      if (same) return;
    }
    const inner = `<div class="drill-inline">
        <div class="drill-inline-head">
          <span class="drill-inline-title">${escapeHtml(entry.title)}</span>${entry.sub && entry.sub.trim().toLowerCase() !== entry.title.trim().toLowerCase() ? `<span class="drill-inline-sub">${escapeHtml(entry.sub)}</span>` : ""}
          <button type="button" class="drill-inline-close" aria-label="Close">&times;</button>
        </div>
        <div class="drill-inline-body"></div>
      </div>`;
    let panel, key;
    const tr = el.closest("tr");
    if (tr) {
      key = tr;
      const cols = Array.from(tr.cells).reduce((n, c) => n + (c.colSpan || 1), 0) || 1;
      panel = document.createElement("tr");
      panel.className = "drill-inline-row";
      panel.innerHTML = `<td colspan="${cols}">${inner}</td>`;
      if (tr.parentElement.tagName === "THEAD") {
        const tb = tr.closest("table").tBodies[0];
        if (tb) tb.insertBefore(panel, tb.firstChild); else tr.after(panel);
      } else {
        tr.after(panel);
      }
    } else {
      // Not in a table: open it right below the thing clicked. Inside a grid/flex
      // strip (stat cells) or an SVG chart, go below the whole strip / chart instead.
      let anchor = el instanceof SVGElement ? (el.closest("svg") || el) : el;
      const par = anchor.parentElement;
      const disp = par ? getComputedStyle(par).display : "";
      const inStatGrid = par && par.classList.contains("stat-table-grid");
      if (inStatGrid) {
        // The big stat table: open right under the row of stats that was clicked, not under all
        // 20-odd of them (which could be a screen and a half away from the number you tapped).
        const top = anchor.offsetTop;
        while (anchor.nextElementSibling && !anchor.nextElementSibling.classList.contains("drill-inline-wrap") && anchor.nextElementSibling.offsetTop === top) anchor = anchor.nextElementSibling;
        key = par; // one open panel per grid
      } else {
        if (/grid|flex/.test(disp)) anchor = par;
        key = anchor;
      }
      panel = document.createElement("div");
      panel.className = "drill-inline-wrap" + (inStatGrid ? " drill-in-grid" : "");
      panel.innerHTML = inner;
      anchor.after(panel);
    }
    // One open panel per row / strip: opening a sibling folds the previous one.
    if (key._drillEl && key._drillEl !== el) closeInline(key._drillEl);
    key._drillEl = el;
    panel._drill = { entry, shown: DRILL_PAGE, key, owner: el };
    el._drillPanel = panel;
    el.setAttribute("aria-expanded", "true");
    el.classList.add("drill-open");
    panel.setAttribute("data-fresh", "");
    paintDrillPanel(panel);
    // Charts / stat strips open their panel below the whole chart or strip, which can
    // be a long way down on a phone -- bring it into view instead of making you hunt.
    requestAnimationFrame(() => {
      const r = panel.getBoundingClientRect();
      const top = 70; // clear of the sticky top bar
      if (r.top > window.innerHeight * 0.55 || r.top < top) {
        window.scrollBy({ top: r.top - top - 10, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }
    });
  }
  Object.assign(R, { DRILL_PAGE, closeInline, drillAttr, drillNum, drillRegistry, drillStamp, paintDrillPanel, toggleExec, toggleInline, unescHtml });
})();
