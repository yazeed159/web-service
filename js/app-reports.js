(function () {
  "use strict";

  // Reports tab of index.html. Split out of the old app.js -- see the big
  // comment at the top of app-shared.js (loaded right before this file on
  // every navigation here) for how these files fit together. Reads/writes
  // shared trade data via `App.state` (including the temporary filtered-
  // subset swap in applyReportFiltersAndRender below -- see its comment);
  // registers its two entry points on `App.tabs.reports` so app-shared.js's
  // fetch-then-render pass can call them once data loads.

  // Report-only filter/view state -- never read outside this file.
  // Defaults for the "Advanced" filters (side / result / P&L, price and
  // share ranges / entry time / weekday). Spread into every place a fresh
  // filter object is built so "no filter" is defined in exactly one spot.
  const ADV_DEFAULTS = {
    side: "all", result: "all",
    pnlMin: null, pnlMax: null, priceMin: null, priceMax: null, sharesMin: null, sharesMax: null,
    timeFrom: "", timeTo: "",
  };
  let reportFilters = { symbol: "", tags: [], durationMin: null, durationMax: null, setup: "all", dateFrom: "", dateTo: "", ...ADV_DEFAULTS, days: [] };
  let updateFiltersToggle = function () {}; // set by initReportFilters (phone filter bar summary)
  let reportPeriodTimeframe = "monthly"; // daily | weekly | monthly | yearly -- see renderPeriodDistPerf
  // Unique-id counter for every trade-list toggle row this tab renders
  // (symbol/DOW/time-of-day/duration breakdowns, leaderboards, sector/
  // country, win/loss days, detail lessons/distribution -- anywhere a
  // row expands into its underlying trades via data-trade-toggle). Was
  // missing its declaration entirely -- every `reportRowSeq++` below
  // threw a ReferenceError under this file's "use strict", which
  // safeRender (app-shared.js) quietly caught, leaving each of those
  // sections stuck on "Loading…" and then swept into the generic
  // "Couldn't load this section" placeholder.
  let reportRowSeq = 0;

  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
    drillRegistry.set(id, {
      title: String(title), sub: opts.sub || "", trades,
      focus: opts.focus || "",        // "hold" | "comm" | "share": the column this stat is actually about
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
  const DRILL_PAGE = 25;
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
    return null;
  }
  function drillColumns(focus) {
    const pnl = (t) => drillNum(t.pnl_after_comm);
    const cols = [
      { label: "Date", cls: "mono", cell: (t) => escapeHtml(t.trade_date || "—") },
      { label: "Symbol", cell: (t) => `<a href="trade.html?id=${encodeURIComponent(t.id)}" class="drill-sym">${escapeHtml(t.symbol || "?")}</a>` },
      { label: "Side", opt: true, cell: (t) => (t.side ? `<span class="drill-side ${/^s/i.test(String(t.side)) ? "short" : "long"}">${escapeHtml(String(t.side))}</span>` : "—") },
      { label: "Setup", opt: true, cell: (t) => (t.setup_type ? `<span class="drill-tag">${escapeHtml(prettifyTag(t.setup_type))}</span>` : "—") },
      { label: "Entry", cls: "mono", opt: Boolean(focus), cell: (t) => (typeof t.entry_time === "string" && t.entry_time ? t.entry_time.slice(0, 5) : "—") },
      { label: "Hold", cls: "mono", opt: focus !== "hold", focus: focus === "hold", cell: (t) => { const h = App.durationMinutes(t); return h != null ? App.fmtDurationPrecise(h) : "—"; },
        foot: (ts) => { const v = ts.map(App.durationMinutes).filter((x) => x != null); return v.length ? "avg " + fmtDuration(v.reduce((a, b) => a + b, 0) / v.length) : ""; } },
      { label: "Shares", cls: "mono num", opt: true, cell: (t) => (t.shares != null ? Number(t.shares).toLocaleString() : "—") },
    ];
    if (focus === "comm") cols.push({ label: "Comm.", cls: "mono num", focus: true, cell: (t) => "$" + (Number(t.commission) || 0).toFixed(2),
      foot: (ts) => "$" + ts.reduce((a, t) => a + (Number(t.commission) || 0), 0).toFixed(2) });
    if (focus === "share") cols.push({ label: "P&amp;L / share", cls: "mono num", focus: true, cell: (t) => { const v = drillPerShare(t); return v == null ? "—" : fmtMoney(v); },
      foot: (ts) => { const v = ts.map(drillPerShare).filter((x) => x != null); return v.length ? "avg " + fmtMoney(v.reduce((a, b) => a + b, 0) / v.length) : ""; } });
    cols.push({ label: "Net P&amp;L", cls: "mono num", cell: (t) => `<span class="${pnl(t) >= 0 ? "up" : "down"}">${fmtMoney(pnl(t))}</span>`, pnlCol: true });
    return cols;
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
    const cols = drillColumns(entry.focus);
    const sorted = drillSort(trades, entry);
    const net = sorted.reduce((sum, t) => sum + drillNum(t.pnl_after_comm), 0);
    const remaining = sorted.length - Math.min(shown, sorted.length);
    const th = (c) => `<th scope="col" class="${c.cls && /num/.test(c.cls) ? "num" : ""}${c.opt ? " drill-opt" : ""}${c.focus ? " drill-focus" : ""}">${c.label}</th>`;
    const td = (c, t) => `<td class="${c.cls || ""}${c.opt ? " drill-opt" : ""}${c.focus ? " drill-focus" : ""}">${c.cell(t)}</td>`;
    // Footer: trade count under Date+Symbol, the focus total under its own column, net P&L at the end.
    const foot = cols.map((c, i) => {
      if (i === 0) return `<td colspan="2">${sorted.length} trade${sorted.length === 1 ? "" : "s"}</td>`;
      if (i === 1) return "";
      const cls = `${c.cls && /num/.test(c.cls) ? "num " : ""}${c.opt ? "drill-opt" : ""}${c.focus ? " drill-focus" : ""}`;
      if (c.pnlCol) return `<td class="mono num ${net >= 0 ? "up" : "down"}">${fmtMoney(net)}</td>`;
      return `<td class="${cls}">${c.foot && c.focus ? c.foot(sorted) : ""}</td>`;
    }).join("");
    return `<div class="table-scroll"><table class="report-table drill-table no-stack"><thead><tr>${cols.map(th).join("")}</tr></thead>
      <tbody>${sorted.slice(0, shown).map((t) => `<tr>${cols.map((c) => td(c, t)).join("")}</tr>`).join("")}</tbody>
      <tfoot><tr>${foot}</tr></tfoot></table></div>
      ${remaining > 0 ? `<div class="drill-more-wrap"><button type="button" class="btn-load-more drill-more">Show more (${remaining} left)</button></div>` : ""}`;
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
  const reportsRoot = document.getElementById("tab-reports");
  if (reportsRoot) {
    reportsRoot.addEventListener("click", (e) => {
      const closeBtn = e.target.closest(".drill-inline-close");
      const more = e.target.closest(".drill-more, .drill-reveal");
      const panel = (closeBtn || more) && (closeBtn || more).closest(".drill-inline-row, .drill-inline-wrap");
      if (panel && panel._drill) {
        if (more && more.classList.contains("drill-reveal")) {
          panel._drill.revealed = true;
          paintDrillPanel(panel);
        } else if (closeBtn) {
          const owner = panel._drill.owner;
          closeInline(owner);
          if (owner && owner.focus && document.contains(owner)) { try { owner.focus({ preventScroll: true }); } catch (err) { owner.focus(); } }
        } else {
          panel._drill.shown += DRILL_PAGE;
          panel.removeAttribute("data-fresh"); // only a newly opened panel staggers its rows in
          paintDrillPanel(panel);
        }
        return;
      }
      const el = e.target.closest("[data-drill]");
      if (!el || !reportsRoot.contains(el)) return;
      // A real link / control inside a drillable row keeps doing its own thing.
      const ctl = e.target.closest("a, button, input, select, textarea, label");
      if (ctl && ctl !== el && el.contains(ctl)) return;
      toggleInline(el, drillRegistry.get(el.getAttribute("data-drill")));
    }, { signal: App.signal });
    reportsRoot.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const el = e.target.closest && e.target.closest("[data-drill]");
      if (!el || e.target !== el) return;
      e.preventDefault();
      toggleInline(el, drillRegistry.get(el.getAttribute("data-drill")));
    }, { signal: App.signal });
  }

  // ----------------------------------------------------------------
  // Reports — Tradervue-style axis bar charts, donut, and equity-curve
  // charts. Plain inline SVG (no charting library) so these stay cheap
  // to render inside a list of report panels.
  // ----------------------------------------------------------------
  function fmtAxisMoney(v) {
    const abs = Math.abs(v);
    const s = abs >= 1000 ? "$" + (abs / 1000).toFixed(abs >= 10000 ? 0 : 1) + "k" : "$" + Math.round(abs);
    return (v < 0 ? "-" : "") + s;
  }
  function fmtAxisCount(v) { return String(Math.round(v)); }
  // rows: [{label, value, color}]. Draws horizontal bars from a shared
  // zero-line, with a labeled numeric axis underneath -- same shape as
  // Tradervue's "Distribution by X" / "Performance by X" pairs.
  function svgAxisBarChart(rows, opts) {
    opts = opts || {};
    const width = opts.width || 480;
    const barH = opts.barHeight || 20;
    const gap = 9;
    const labelW = opts.labelW || 108;
    const rightPad = 10;
    const rowH = barH + gap;
    const topPad = 4, bottomPad = 24;
    const plotW = Math.max(60, width - labelW - rightPad);
    const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
    const hasNeg = rows.some((r) => r.value < 0);
    const height = topPad + rows.length * rowH + bottomPad;
    const fmt = opts.fmt || ((v) => String(v));
    const zeroX = hasNeg ? plotW / 2 : 0;
    const scale = (hasNeg ? plotW / 2 : plotW) / maxAbs;

    const gridCount = hasNeg ? 4 : 4;
    let axis = "";
    for (let i = 0; i <= gridCount; i++) {
      const frac = i / gridCount;
      const x = hasNeg ? frac * plotW : frac * plotW;
      const val = hasNeg ? (frac * 2 - 1) * maxAbs : frac * maxAbs;
      const gx = (labelW + x).toFixed(1);
      axis += `<line x1="${gx}" y1="${topPad}" x2="${gx}" y2="${(topPad + rows.length * rowH).toFixed(1)}" stroke="var(--border)" stroke-width="1" opacity="0.6"/>`;
      axis += `<text x="${gx}" y="${(topPad + rows.length * rowH + 16).toFixed(1)}" font-size="10" fill="var(--text-faint)" text-anchor="middle">${escapeHtml(fmt(val))}</text>`;
    }
    const bars = rows.map((r, i) => {
      const y = topPad + i * rowH;
      const barW = Math.max(Math.abs(r.value) * scale, r.value === 0 ? 0 : 1.5);
      const x = hasNeg ? (r.value >= 0 ? labelW + zeroX : labelW + zeroX - barW) : labelW;
      const color = r.color || "var(--green)";
      const tip = `${escapeHtml(r.label)}: ${escapeHtml(fmt(r.value))}`;
      const inner = `<text x="${labelW - 8}" y="${(y + barH / 2 + 4).toFixed(1)}" font-size="11" fill="var(--text-dim)" text-anchor="end">${escapeHtml(r.label)}</text>` +
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH}" rx="2" fill="${color}"><title>${tip}${r.trades && r.trades.length ? " \u2014 click for trades" : ""}</title></rect>`;
      // Rows that carry `trades` become clickable (whole row is the hit area).
      const da = drillAttr(r.drillTitle || r.label, r.trades, { sub: r.drillSub || opts.context });
      if (!da) return inner;
      return `<g class="drillable"${da}><rect x="0" y="${(y - gap / 2).toFixed(1)}" width="${width}" height="${rowH}" fill="transparent"/>${inner}</g>`;
    }).join("");
    const zeroLine = hasNeg ? `<line x1="${(labelW + zeroX).toFixed(1)}" y1="${topPad}" x2="${(labelW + zeroX).toFixed(1)}" y2="${(topPad + rows.length * rowH).toFixed(1)}" stroke="var(--text-faint)" stroke-width="1.3"/>` : "";
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" style="overflow:visible; display:block;">${axis}${bars}${zeroLine}</svg>`;
  }
  // buckets: [{label, trades}]. Renders the "count" side into distElId
  // and the "net P&L" side into perfElId -- the paired chart Tradervue
  // shows for price, size, symbol, and volume breakdowns.
  function renderPairedHistogram(distElId, perfElId, buckets, opts) {
    const distEl = document.getElementById(distElId), perfEl = document.getElementById(perfElId);
    if (!distEl || !perfEl) return;
    const present = buckets.filter((b) => b.trades.length);
    if (!present.length) {
      distEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      perfEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      return;
    }
    const distRows = present.map((b) => ({ label: b.label, value: b.trades.length, color: "var(--green)", trades: b.trades }));
    const perfRows = present.map((b) => {
      const net = b.trades.reduce((s, t) => s + t.pnl_after_comm, 0);
      return { label: b.label, value: net, color: net >= 0 ? "var(--green)" : "var(--red)", trades: b.trades };
    });
    distEl.innerHTML = svgAxisBarChart(distRows, Object.assign({ fmt: fmtAxisCount }, opts));
    perfEl.innerHTML = svgAxisBarChart(perfRows, Object.assign({ fmt: fmtAxisMoney }, opts));
  }
  function svgDonutChart(winPct, opts) {
    opts = opts || {};
    const size = opts.size || 220, stroke = opts.stroke || 34;
    const r = (size - stroke) / 2, c = size / 2;
    const circ = 2 * Math.PI * r;
    const winLen = (winPct / 100) * circ;
    const lossAttr = ""; // win/loss lists are just Journal filters -- not clickable
    const winAttr = "";
    // The hole in the middle opens every trade (the ring segments open just the winners / losers).
    const allAttr = "";
    return `<svg viewBox="0 0 ${size} ${size}" width="100%" height="${size}" style="max-width:${size}px; display:block; margin:0 auto;">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--red)" stroke-width="${stroke}"${lossAttr}/>
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--green)" stroke-width="${stroke}"
        stroke-dasharray="${winLen.toFixed(1)} ${circ.toFixed(1)}" stroke-dashoffset="${(circ * 0.25).toFixed(1)}" transform="scale(1,-1)" style="transform-origin:${c}px ${c}px;"${winAttr}/>
      <circle cx="${c}" cy="${c}" r="${(r - stroke / 2 - 2).toFixed(1)}" fill="transparent"${allAttr}/>
      <text x="${c}" y="${c - 4}" text-anchor="middle" font-size="22" font-weight="700" fill="var(--green)" style="pointer-events:none;">${winPct.toFixed(1)}%</text>
      <text x="${c}" y="${c + 16}" text-anchor="middle" font-size="11" fill="var(--text-faint)" style="pointer-events:none;">win rate</text>
    </svg>`;
  }
  // Interactive line/area chart -- same crosshair + tooltip UX as the
  // dashboard's equity curve (bindEquityInteractivity below), generalized
  // so any number of independent instances can live on one page at once
  // (Reports has several: Drawdown tab's two charts, Overview's
  // date-range-toggle one, Win/Loss/Expectation's). Renders its own
  // wrap/svg/crosshair/tooltip markup straight into `container` and binds
  // events scoped to that element, rather than assuming fixed page-wide
  // ids the way the dashboard's singleton chart does.
  // series: [{ x: <label shown in tooltip>, y: <number> }, ...] in
  // chronological order.
  let mlcSeq = 0;
  // Splits a polyline into pieces that never cross the threshold line --
  // used so a chart can color each stretch by whether IT is above/below
  // zero, instead of painting the whole curve by only its final value.
  // Every (x1,y1)-(x2,y2) pair from `coords` is classified by the sign of
  // its two `values` relative to thresholdValue; a pair that actually
  // crosses gets split at the interpolated crossing point (thresholdY) so
  // the color switches exactly where the data does, not at the nearest
  // sampled point.
  function splitSignedSegments(coords, values, thresholdY, thresholdValue) {
    const segs = [];
    for (let i = 0; i < coords.length - 1; i++) {
      const [x1, y1] = coords[i], [x2, y2] = coords[i + 1];
      const v1 = values[i], v2 = values[i + 1];
      const pos1 = v1 >= thresholdValue, pos2 = v2 >= thresholdValue;
      if (pos1 === pos2) {
        segs.push({ x1, y1, x2, y2, positive: pos1 });
      } else {
        const t = (thresholdValue - v1) / (v2 - v1);
        const xm = x1 + (x2 - x1) * t;
        segs.push({ x1, y1, x2: xm, y2: thresholdY, positive: pos1 });
        segs.push({ x1: xm, y1: thresholdY, x2, y2, positive: pos2 });
      }
    }
    return segs;
  }
  function renderMiniLineChart(container, series, opts) {
    opts = opts || {};
    if (!container) return;
    if (!series.length) { container.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    const valueFmt = opts.valueFmt || fmtMoney;
    const W = 1000, H = opts.height || 130, PAD = 8;

    const values = series.map((p) => p.y);
    const min = Math.min(0, ...values), max = Math.max(0, ...values);
    const range = max - min || 1;
    const coords = series.map((p, i) => {
      const x = series.length > 1 ? (i / (series.length - 1)) * W : 0;
      const y = H - PAD - ((p.y - min) / range) * (H - PAD * 2);
      return [x, y];
    });
    const zeroY = H - PAD - ((0 - min) / range) * (H - PAD * 2);
    const finalPositive = values[values.length - 1] >= 0;

    const segs = coords.length > 1 ? splitSignedSegments(coords, values, zeroY, 0) : [];
    const fmt1 = (n) => n.toFixed(1);
    const strokeMarkup = segs.length
      ? segs.map((s) => `<path d="M${fmt1(s.x1)},${fmt1(s.y1)} L${fmt1(s.x2)},${fmt1(s.y2)}" class="equity-path ${s.positive ? "" : "neg"}" />`).join("")
      : `<path d="M${fmt1(coords[0][0])},${fmt1(coords[0][1])} L${fmt1(coords[0][0])},${fmt1(coords[0][1])}" class="equity-path ${finalPositive ? "" : "neg"}" />`;
    const fillMarkup = segs.map((s) => `<path d="M${fmt1(s.x1)},${fmt1(s.y1)} L${fmt1(s.x2)},${fmt1(s.y2)} L${fmt1(s.x2)},${fmt1(zeroY)} L${fmt1(s.x1)},${fmt1(zeroY)} Z" fill="${s.positive ? "#2fd08a" : "#f2555a"}" fill-opacity="0.14" />`).join("");

    container.innerHTML = `
      <div class="equity-chart-wrap mini-line-wrap">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:${H}px; display:block;">
          <line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}" class="equity-zero" />
          ${fillMarkup}
          ${strokeMarkup}
          <circle class="mlc-hover-dot" r="4" fill="var(--panel)" stroke="${finalPositive ? "var(--green)" : "var(--red)"}" stroke-width="2" style="display:none;" />
        </svg>
        <div class="equity-crosshair mlc-crosshair"></div>
        <div class="equity-tooltip mlc-tooltip"></div>
      </div>`;

    const wrap = container.querySelector(".mini-line-wrap");
    const crosshair = container.querySelector(".mlc-crosshair");
    const tooltip = container.querySelector(".mlc-tooltip");
    const dot = container.querySelector(".mlc-hover-dot");
    const coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    const tradeAt = (i) => (opts.trades && opts.trades[i]) || null; // series[i] <-> opts.trades[i]

    // One AbortController per render: re-rendering this container (range toggle,
    // filters) drops the previous chart's listeners instead of stacking them.
    if (container._mlcCtl) container._mlcCtl.abort();
    const ctl = (container._mlcCtl = new AbortController());
    (opts.signal || App.signal).addEventListener("abort", () => ctl.abort(), { once: true, signal: ctl.signal });
    const sig = ctl.signal;

    let shownIdx = -1;
    function nearestIndex(clientX) {
      const rect = wrap.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return Math.round(frac * (series.length - 1));
    }
    function showAt(clientX) {
      const i = nearestIndex(clientX);
      shownIdx = i;
      const [cx, cy] = coords[i];
      const rect = wrap.getBoundingClientRect();
      const pxX = (cx / W) * rect.width;
      crosshair.style.display = "block";
      crosshair.style.left = `${pxX}px`;
      dot.style.display = "block";
      dot.setAttribute("cx", cx.toFixed(1));
      dot.setAttribute("cy", cy.toFixed(1));
      dot.setAttribute("stroke", values[i] >= 0 ? "var(--green)" : "var(--red)");
      const p = series[i];
      const t = tradeAt(i);
      let html = `<div class="eq-date">${escapeHtml(p.x)}</div><div class="eq-bal">${valueFmt(p.y)}</div>`;
      if (t) {
        html += `<div class="eq-trade">${escapeHtml(t.symbol)} <span class="${t.pnl_after_comm >= 0 ? "up" : "down"}">${fmtMoney(t.pnl_after_comm)}</span></div>`;
        html += `<div class="eq-hint">${coarse ? "Tap again to open trade" : "Click to open trade"} \u2192</div>`;
      }
      tooltip.innerHTML = html;
      tooltip.style.display = "block";
      const ttWidth = tooltip.offsetWidth || 120;
      let left = pxX + 10;
      if (left + ttWidth > rect.width) left = pxX - ttWidth - 10;
      if (left < 0) left = 4;
      tooltip.style.left = `${left}px`;
    }
    function hide() {
      shownIdx = -1;
      crosshair.style.display = "none";
      tooltip.style.display = "none";
      dot.style.display = "none";
    }

    // Mouse: hover as before. Touch: press and hold (~200ms) then drag to scrub
    // along the curve; a quick swipe still scrolls the page. A plain tap shows
    // that point, and tapping the same point again opens the trade.
    wrap.addEventListener("pointermove", (e) => { if (e.pointerType !== "touch") showAt(e.clientX); }, { signal: sig });
    wrap.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") hide(); }, { signal: sig });

    let holdTimer = null, scrubbing = false, suppressClick = false;
    let sx = 0, sy = 0, lastX = 0;
    const endHold = () => { clearTimeout(holdTimer); holdTimer = null; };
    wrap.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) { endHold(); return; }
      sx = lastX = e.touches[0].clientX; sy = e.touches[0].clientY;
      endHold();
      holdTimer = setTimeout(() => {
        holdTimer = null; scrubbing = true;
        wrap.classList.add("scrubbing");
        try { if (navigator.vibrate) navigator.vibrate(8); } catch (err) {}
        showAt(lastX);
      }, 200);
    }, { passive: true, signal: sig });
    wrap.addEventListener("touchmove", (e) => {
      const t = e.touches[0];
      if (!t) return;
      lastX = t.clientX;
      if (scrubbing) {
        if (e.cancelable) e.preventDefault(); // keep the page from scrolling while scrubbing
        showAt(t.clientX);
      } else if (Math.abs(t.clientX - sx) > 8 || Math.abs(t.clientY - sy) > 8) {
        endHold(); // finger moved before the hold registered: it is a scroll
      }
    }, { passive: false, signal: sig });
    const touchDone = () => {
      endHold();
      if (scrubbing) {
        scrubbing = false;
        wrap.classList.remove("scrubbing");
        suppressClick = true; // the click synthesised on release must not open the trade
        setTimeout(() => { suppressClick = false; }, 400);
      }
    };
    wrap.addEventListener("touchend", touchDone, { signal: sig });
    wrap.addEventListener("touchcancel", touchDone, { signal: sig });
    wrap.addEventListener("contextmenu", (e) => { if (coarse) e.preventDefault(); }, { signal: sig });
    // Tapping anywhere else clears the readout left on screen.
    document.addEventListener("touchstart", (e) => { if (!wrap.contains(e.target)) hide(); }, { passive: true, signal: sig });

    // Click / tap goes straight to that trade's page (no dropdown). On a phone
    // the first tap only shows the point; tapping the same point again opens it.
    wrap.addEventListener("click", (e) => {
      if (suppressClick) return;
      const i = nearestIndex(e.clientX);
      const t = tradeAt(i);
      if (!t || !t.id) return;
      if (coarse && shownIdx !== i) { showAt(e.clientX); return; }
      window.location.href = `trade.html?id=${encodeURIComponent(t.id)}`;
    }, { signal: sig });
  }
  // ----------------------------------------------------------------
  // Reports — click-to-expand trade lists (same pattern as patterns.html's
  // tag-trade-list: click a leaderboard/breakdown row to reveal the exact
  // trades behind it, each linking straight to trade.html?id=...).
  //
  // Rendered TRADE_LIST_PAGE_SIZE at a time with a "Load more" button
  // rather than dumping every trade behind a symbol/tag/day into the DOM
  // at once -- a heavily-traded symbol or a "loss days" bucket can run
  // into the hundreds, and that was making those sections (collapsed or
  // not) enormous.
  // ----------------------------------------------------------------
  // tradeListItemHtml/tradeListMoreHtml/tradeListHtml/
  // TRADE_LIST_PAGE_SIZE/tradeListState/bindTradeToggles all now in
  // utils.js (identical here to edge-analysis.js/patterns.html/
  // stats.html's copies, minus their URL-sync step -- see utils.js).
  // Shared "key -> {trades, net}" breakdown table with a Load More button
  // -- used by Overview's "By symbol" and the Sector/Country tables. A
  // busy account can have hundreds of symbols; rendering a <tr> for every
  // one of them at once (even those collapsed) is exactly what was
  // making the Reports page slow to load. Same fix as tradeListHtml's
  // Load More above, just at the row level instead of the nested
  // trade-list level.
  const BREAKDOWN_PAGE_SIZE = 25;
  const breakdownTableState = new Map(); // elId -> { rowsHtml, shown }
  function renderPaginatedBreakdownTable(elId, entries, colLabel, rowHtmlFn) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!entries.length) {
      el.innerHTML = `<div class="empty-state small">No ${escapeHtml(colLabel.toLowerCase())} data yet.</div>`;
      return;
    }
    breakdownTableState.set(elId, { rowsHtml: entries.map(rowHtmlFn), shown: BREAKDOWN_PAGE_SIZE });
    el.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">${colLabel}</th><th scope="col">Trades</th><th scope="col">Win %</th><th scope="col">Net P&amp;L</th></tr></thead><tbody id="${elId}-tbody"></tbody></table></div>`;
    renderBreakdownTablePage(elId);
  }
  function renderBreakdownTablePage(elId) {
    const state = breakdownTableState.get(elId);
    const tbody = document.getElementById(`${elId}-tbody`);
    if (!state || !tbody) return;
    const shown = Math.min(state.shown, state.rowsHtml.length);
    const remaining = state.rowsHtml.length - shown;
    const moreHtml = remaining > 0
      ? `<tr class="report-row-more"><td colspan="4" style="text-align:center; padding:10px;"><button type="button" class="btn-load-more" data-load-more-table="${elId}">Load more (${remaining} left)</button></td></tr>`
      : "";
    tbody.innerHTML = state.rowsHtml.slice(0, shown).join("") + moreHtml;
    bindTradeToggles(tbody);
    const btn = tbody.querySelector("[data-load-more-table]");
    if (btn) {
      btn.addEventListener("click", () => {
        state.shown += BREAKDOWN_PAGE_SIZE;
        renderBreakdownTablePage(elId);
      }, { signal: App.signal });
    }
  }

  // ----------------------------------------------------------------
  // Reports sub-tab / top-level-tab / Compare-controls wiring (was loose
  // top-level code in the old app.js's shared "TAB NAVIGATION" section --
  // moved here since all of it is Reports-only).
  // ----------------------------------------------------------------
  // Reports → Detailed stats sub-tabs (separate from the main sidebar tabs)
  document.querySelectorAll(".subtab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".subtab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".subtab-panel").forEach((p) => p.classList.toggle("active", p.id === "subtab-" + btn.dataset.subtab));
    }, { signal: App.signal });
  });

  // Reports → top-level tabs (Overview / Detailed / Win vs Loss Days / Drawdown / Compare / Tag Breakdown / Advanced)
  document.querySelectorAll(".toptab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".toptab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".toptab-panel").forEach((p) => p.classList.toggle("active", p.id === "toptab-" + btn.dataset.toptab));
    }, { signal: App.signal });
  });

  // Reports → Compare tab controls (not gated behind trades having loaded —
  // periodStats() just returns an empty result until data arrives)
  const cmpApplyBtn = document.getElementById("cmp-apply");
  if (cmpApplyBtn) cmpApplyBtn.addEventListener("click", updateCompare, { signal: App.signal });
  ["cmp-a-start", "cmp-a-end", "cmp-b-start", "cmp-b-end"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", updateCompare, { signal: App.signal });
  });


  function matchesReportFilters(t) {
    if (reportFilters.symbol && !t.symbol.toLowerCase().includes(reportFilters.symbol.toLowerCase())) return false;
    if (reportFilters.setup !== "all" && t.setup_type !== reportFilters.setup) return false;
    if (reportFilters.tags.length) {
      const tags = t.lesson_tags || [];
      if (!reportFilters.tags.some((tag) => tags.includes(tag))) return false;
    }
    if (reportFilters.durationMin !== null || reportFilters.durationMax !== null) {
      const mins = App.durationMinutes(t);
      if (mins === null) return false;
      if (reportFilters.durationMin !== null && mins < reportFilters.durationMin) return false;
      if (reportFilters.durationMax !== null && mins > reportFilters.durationMax) return false;
    }
    if (reportFilters.dateFrom && t.trade_date < reportFilters.dateFrom) return false;
    if (reportFilters.dateTo && t.trade_date > reportFilters.dateTo) return false;

    // ---- Advanced filters. A trade missing the field being filtered on
    // (no price / no entry time recorded) can't satisfy the filter, so it's
    // left out -- same rule the duration filter above uses.
    const f = reportFilters;
    if (f.side !== "all" && String(t.side || "").toLowerCase() !== f.side) return false;
    if (f.result !== "all" && Boolean(t.win) !== (f.result === "win")) return false;
    if (!inNumRange(t.pnl_after_comm, f.pnlMin, f.pnlMax)) return false;
    if (!inNumRange(t.entry_price, f.priceMin, f.priceMax)) return false;
    if (!inNumRange(t.shares, f.sharesMin, f.sharesMax)) return false;
    if (f.timeFrom || f.timeTo) {
      const hm = typeof t.entry_time === "string" ? t.entry_time.slice(0, 5) : "";
      if (!hm) return false;
      if (f.timeFrom && hm < f.timeFrom) return false;
      if (f.timeTo && hm > f.timeTo) return false;
    }
    if (f.days.length) {
      // Build the date from its parts (local time) -- new Date("YYYY-MM-DD")
      // is UTC midnight and can land on the previous weekday in some zones.
      const [y, m, d] = String(t.trade_date).split("-").map(Number);
      if (!f.days.includes(new Date(y, m - 1, d).getDay())) return false;
    }
    return true;
  }
  function inNumRange(v, lo, hi) {
    if (lo === null && hi === null) return true;
    const n = v == null || v === "" ? NaN : Number(v);
    if (!Number.isFinite(n)) return false;
    return (lo === null || n >= lo) && (hi === null || n <= hi);
  }
  // renderReports() (and everything it calls) reads the closured `trades`
  // variable. Rather than threading a filtered list through ~20 functions,
  // swap `trades` for the filtered subset for the duration of that
  // (synchronous) render pass, then restore it. Safe because nothing in
  // the reports render chain does anything async.
  function applyReportFiltersAndRender() {
    const fullTrades = App.state.trades;
    App.state.trades = fullTrades.filter(matchesReportFilters);
    // try/finally: if a render throws, state.trades must still go back to
    // the full list -- the Day View and Dashboard read it too.
    try {
      renderReports();
    } finally {
      App.state.trades = fullTrades;
    }
  }
  // initReportFilters() runs once per render pass that (re)builds the filter
  // bar -- and Reports can render twice on arrival (the cached on-device
  // snapshot first, then the fresh network data). Each run used to stack a
  // second set of listeners on the SAME buttons, so on a phone the Filters
  // button opened the sheet and the duplicate closed it again in the same tap
  // (and Advanced, Tags and the weekday chips cancelled themselves out the
  // same way). Every run now drops the previous run's listeners first; they
  // still all die with App.signal when the page is torn down.
  let filterInitCtl = null;
  function freshFilterSignal() {
    if (filterInitCtl) filterInitCtl.abort();
    const ctl = (filterInitCtl = new AbortController());
    App.signal.addEventListener("abort", () => ctl.abort(), { once: true, signal: ctl.signal });
    return ctl.signal;
  }
  function initReportFilters() {
    const symbolInput = document.getElementById("report-filter-symbol");
    const setupSel = document.getElementById("report-filter-setup");
    const durMinInput = document.getElementById("report-filter-duration-min");
    const durMaxInput = document.getElementById("report-filter-duration-max");
    const dateFromInput = document.getElementById("report-filter-date-from");
    const dateToInput = document.getElementById("report-filter-date-to");
    const tagsToggle = document.getElementById("report-filter-tags-toggle");
    const tagsPanel = document.getElementById("report-filter-tags-panel");
    if (!symbolInput || !setupSel || !durMinInput || !durMaxInput || !dateFromInput || !dateToInput || !tagsToggle || !tagsPanel) return;
    const sig = freshFilterSignal();

    const setups = Array.from(new Set(App.state.trades.map((t) => t.setup_type).filter(Boolean))).sort();
    setupSel.innerHTML =
      '<option value="all">All</option>' +
      setups.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(prettifyTag(s))}</option>`).join("");

    const tagSet = new Set();
    App.state.trades.forEach((t) => (t.lesson_tags || []).forEach((tag) => tagSet.add(tag)));
    const tags = Array.from(tagSet).sort();
    tagsPanel.innerHTML = tags.length
      ? tags.map((tag) => `<label><input type="checkbox" value="${escapeHtml(tag)}"> ${escapeHtml(prettifyTag(tag))}</label>`).join("")
      : '<div class="tags-panel-empty">No tags logged yet.</div>';

    // The actual span of logged trades -- what "Clear filters" resets the
    // date range back to, and what a fresh (no-URL-state) visit starts
    // from, instead of a frozen, hand-typed placeholder date.
    const defaultFrom = App.state.trades.length ? App.state.trades[0].trade_date : "";
    const defaultTo = App.state.trades.length ? App.state.trades[App.state.trades.length - 1].trade_date : "";

    // Restore a search from the URL if we're coming back here (Back
    // button from trade.html) instead of landing fresh -- same NavState
    // pattern used for the calendar/day-view above. Without this, every
    // trip into a trade and back reset the whole filter bar, and typing
    // the exact same search again was the only way to get back to where
    // you were.
    function parseNum(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
    reportFilters.symbol = NavState.get("rsym", "");
    reportFilters.setup = NavState.get("rsetup", "all");
    reportFilters.durationMin = parseNum(NavState.get("rdmin", ""));
    reportFilters.durationMax = parseNum(NavState.get("rdmax", ""));
    const urlTags = NavState.get("rtags", "");
    reportFilters.tags = urlTags ? urlTags.split(",").filter((t) => tags.includes(t)) : [];
    reportFilters.dateFrom = NavState.get("rfrom", defaultFrom);
    reportFilters.dateTo = NavState.get("rto", defaultTo);

    symbolInput.value = reportFilters.symbol;
    if (Array.from(setupSel.options).some((o) => o.value === reportFilters.setup)) setupSel.value = reportFilters.setup;
    else reportFilters.setup = setupSel.value = "all";
    durMinInput.value = reportFilters.durationMin === null ? "" : reportFilters.durationMin;
    durMaxInput.value = reportFilters.durationMax === null ? "" : reportFilters.durationMax;
    dateFromInput.value = reportFilters.dateFrom;
    dateToInput.value = reportFilters.dateTo;
    tagsPanel.querySelectorAll("input[type=checkbox]").forEach((cb) => { cb.checked = reportFilters.tags.includes(cb.value); });
    tagsToggle.textContent = reportFilters.tags.length ? `${reportFilters.tags.length} selected` : "All tags";

    // ---- "Advanced" filter panel (opened by the Advanced button).
    const advBtn = document.getElementById("report-filter-advanced");
    const advPanel = document.getElementById("report-advanced-panel");
    const advEls = advPanel ? {
      side: document.getElementById("report-filter-side"),
      result: document.getElementById("report-filter-result"),
      pnlMin: document.getElementById("report-filter-pnl-min"),
      pnlMax: document.getElementById("report-filter-pnl-max"),
      priceMin: document.getElementById("report-filter-price-min"),
      priceMax: document.getElementById("report-filter-price-max"),
      sharesMin: document.getElementById("report-filter-shares-min"),
      sharesMax: document.getElementById("report-filter-shares-max"),
      timeFrom: document.getElementById("report-filter-time-from"),
      timeTo: document.getElementById("report-filter-time-to"),
    } : null;
    const dowChips = advPanel ? Array.from(advPanel.querySelectorAll(".dow-chip")) : [];
    const advNumKeys = ["pnlMin", "pnlMax", "priceMin", "priceMax", "sharesMin", "sharesMax"];
    // URL keys for each advanced filter (kept short, like rsym / rdmin above).
    const ADV_URL = { side: "rside", result: "rres", pnlMin: "rpmin", pnlMax: "rpmax", priceMin: "rprmin", priceMax: "rprmax",
      sharesMin: "rshmin", sharesMax: "rshmax", timeFrom: "rtfrom", timeTo: "rtto" };
    function advancedActiveCount() {
      const f = reportFilters;
      const pair = (a, b) => (f[a] !== null || f[b] !== null ? 1 : 0);
      return (f.side !== "all" ? 1 : 0) + (f.result !== "all" ? 1 : 0)
        + pair("pnlMin", "pnlMax") + pair("priceMin", "priceMax") + pair("sharesMin", "sharesMax")
        + (f.timeFrom || f.timeTo ? 1 : 0) + (f.days.length ? 1 : 0);
    }
    // "Advanced" -> "Advanced · 2" (and highlighted) while any extra filter is set,
    // so a collapsed panel can't be silently narrowing the reports.
    function updateAdvancedBadge() {
      if (!advBtn) return;
      const n = advancedActiveCount();
      advBtn.textContent = n ? `Advanced · ${n}` : "Advanced";
      advBtn.classList.toggle("active", n > 0);
    }
    function syncAdvancedInputs() {
      if (!advEls) return;
      advEls.side.value = reportFilters.side;
      advEls.result.value = reportFilters.result;
      advNumKeys.forEach((k) => { advEls[k].value = reportFilters[k] === null ? "" : reportFilters[k]; });
      advEls.timeFrom.value = reportFilters.timeFrom;
      advEls.timeTo.value = reportFilters.timeTo;
      dowChips.forEach((c) => c.classList.toggle("on", reportFilters.days.includes(Number(c.dataset.dow))));
      updateAdvancedBadge();
    }
    if (advPanel) {
      const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);
      reportFilters.side = oneOf(NavState.get(ADV_URL.side, "all"), ["all", "long", "short"], "all");
      reportFilters.result = oneOf(NavState.get(ADV_URL.result, "all"), ["all", "win", "loss"], "all");
      advNumKeys.forEach((k) => { reportFilters[k] = parseNum(NavState.get(ADV_URL[k], "")); });
      const hhmm = (v) => (/^\d{2}:\d{2}$/.test(v) ? v : "");
      reportFilters.timeFrom = hhmm(NavState.get(ADV_URL.timeFrom, ""));
      reportFilters.timeTo = hhmm(NavState.get(ADV_URL.timeTo, ""));
      const urlDays = NavState.get("rdow", "");
      reportFilters.days = urlDays ? urlDays.split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6) : [];
      syncAdvancedInputs();
      // Coming back to a page with advanced filters in the URL: show them.
      if (advancedActiveCount() > 0) { advPanel.classList.add("open"); advBtn.setAttribute("aria-expanded", "true"); }
    }

    // Writes the whole filter bar into the URL (via NavState) so it
    // survives the round trip through a trade page and back.
    function persistFilters() {
      NavState.set({
        rsym: reportFilters.symbol || null,
        rsetup: reportFilters.setup === "all" ? null : reportFilters.setup,
        rdmin: reportFilters.durationMin === null ? null : reportFilters.durationMin,
        rdmax: reportFilters.durationMax === null ? null : reportFilters.durationMax,
        rtags: reportFilters.tags.length ? reportFilters.tags.join(",") : null,
        rfrom: reportFilters.dateFrom === defaultFrom ? null : reportFilters.dateFrom,
        rto: reportFilters.dateTo === defaultTo ? null : reportFilters.dateTo,
        ...(advPanel ? {
          [ADV_URL.side]: reportFilters.side === "all" ? null : reportFilters.side,
          [ADV_URL.result]: reportFilters.result === "all" ? null : reportFilters.result,
          [ADV_URL.pnlMin]: reportFilters.pnlMin, [ADV_URL.pnlMax]: reportFilters.pnlMax,
          [ADV_URL.priceMin]: reportFilters.priceMin, [ADV_URL.priceMax]: reportFilters.priceMax,
          [ADV_URL.sharesMin]: reportFilters.sharesMin, [ADV_URL.sharesMax]: reportFilters.sharesMax,
          [ADV_URL.timeFrom]: reportFilters.timeFrom || null, [ADV_URL.timeTo]: reportFilters.timeTo || null,
          rdow: reportFilters.days.length ? reportFilters.days.join(",") : null,
        } : {}),
      });
    }

    // Advanced panel: open/close, and keep reportFilters in step with the inputs.
    if (advBtn && advPanel) {
      advBtn.addEventListener("click", () => {
        const open = advPanel.classList.toggle("open");
        advBtn.setAttribute("aria-expanded", String(open));
      }, { signal: sig });
      advEls.side.addEventListener("change", (e) => { reportFilters.side = e.target.value; updateAdvancedBadge(); }, { signal: sig });
      advEls.result.addEventListener("change", (e) => { reportFilters.result = e.target.value; updateAdvancedBadge(); }, { signal: sig });
      advNumKeys.forEach((k) => {
        advEls[k].addEventListener("input", (e) => { reportFilters[k] = parseNum(e.target.value); updateAdvancedBadge(); }, { signal: sig });
      });
      ["timeFrom", "timeTo"].forEach((k) => {
        const onTime = (e) => { reportFilters[k] = e.target.value || ""; updateAdvancedBadge(); };
        advEls[k].addEventListener("input", onTime, { signal: sig });
        advEls[k].addEventListener("change", onTime, { signal: sig });
      });
      dowChips.forEach((chip) => chip.addEventListener("click", () => {
        const d = Number(chip.dataset.dow);
        reportFilters.days = reportFilters.days.includes(d) ? reportFilters.days.filter((x) => x !== d) : reportFilters.days.concat(d);
        chip.classList.toggle("on", reportFilters.days.includes(d));
        updateAdvancedBadge();
      }, { signal: sig }));
    }

    // ---- Phone filter bar: one summary row that opens the whole form (basic + Advanced fields).
    const rftBtn = document.getElementById("rpt-filters-toggle");
    const rftSheet = document.getElementById("rpt-filter-sheet");
    const rftCount = document.getElementById("rpt-filters-count");
    const rftSum = document.getElementById("rpt-filters-sum");
    const shortDate = (iso) => { const d = new Date(iso + "T00:00:00"); return isNaN(d) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
    updateFiltersToggle = function () {
      if (!rftBtn) return;
      const f = reportFilters;
      const n = (f.symbol ? 1 : 0) + (f.setup !== "all" ? 1 : 0) + (f.tags.length ? 1 : 0)
        + (f.durationMin !== null || f.durationMax !== null ? 1 : 0)
        + (f.dateFrom !== defaultFrom || f.dateTo !== defaultTo ? 1 : 0) + advancedActiveCount();
      rftCount.textContent = n ? String(n) : "";
      rftBtn.classList.toggle("has-active", n > 0);
      rftSum.textContent = f.dateFrom && f.dateTo ? `${shortDate(f.dateFrom)} \u2013 ${shortDate(f.dateTo)}` : "All dates";
    };
    function setSheet(open) {
      if (!rftBtn || !rftSheet) return;
      rftSheet.classList.toggle("open", open);
      rftBtn.setAttribute("aria-expanded", String(open));
    }
    if (rftBtn && rftSheet) {
      rftBtn.addEventListener("click", () => setSheet(!rftSheet.classList.contains("open")), { signal: sig });
      // Apply / Clear both re-render; on a phone that should also fold the form away so the results are in view.
      ["report-filter-apply", "report-filter-clear"].forEach((id) => {
        const b = document.getElementById(id);
        if (b) b.addEventListener("click", () => { if (window.matchMedia("(max-width: 760px)").matches) setSheet(false); }, { signal: sig });
      });
    }
    updateFiltersToggle();

    symbolInput.addEventListener("input", (e) => { reportFilters.symbol = e.target.value.trim(); }, { signal: sig });
    setupSel.addEventListener("change", (e) => { reportFilters.setup = e.target.value; }, { signal: sig });
    durMinInput.addEventListener("input", (e) => { reportFilters.durationMin = parseNum(e.target.value); }, { signal: sig });
    durMaxInput.addEventListener("input", (e) => { reportFilters.durationMax = parseNum(e.target.value); }, { signal: sig });
    dateFromInput.addEventListener("change", (e) => { reportFilters.dateFrom = e.target.value || defaultFrom; }, { signal: sig });
    dateToInput.addEventListener("change", (e) => { reportFilters.dateTo = e.target.value || defaultTo; }, { signal: sig });

    tagsToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      tagsPanel.classList.toggle("open");
    }, { signal: sig });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".tags-field")) tagsPanel.classList.remove("open");
    }, { signal: sig });
    tagsPanel.addEventListener("change", () => {
      const checked = Array.from(tagsPanel.querySelectorAll("input:checked")).map((cb) => cb.value);
      reportFilters.tags = checked;
      tagsToggle.textContent = checked.length ? `${checked.length} selected` : "All tags";
    }, { signal: sig });

    const clearBtn = document.getElementById("report-filter-clear");
    if (clearBtn) clearBtn.addEventListener("click", () => {
      reportFilters = { symbol: "", tags: [], durationMin: null, durationMax: null, setup: "all", dateFrom: defaultFrom, dateTo: defaultTo, ...ADV_DEFAULTS, days: [] };
      syncAdvancedInputs();
      symbolInput.value = "";
      setupSel.value = "all";
      durMinInput.value = "";
      durMaxInput.value = "";
      dateFromInput.value = defaultFrom;
      dateToInput.value = defaultTo;
      tagsPanel.querySelectorAll("input:checked").forEach((cb) => (cb.checked = false));
      tagsToggle.textContent = "All tags";
      persistFilters();
      applyReportFiltersAndRender();
    }, { signal: sig });

    const applyBtn = document.getElementById("report-filter-apply");
    if (applyBtn) applyBtn.addEventListener("click", () => {
      persistFilters();
      applyReportFiltersAndRender();
    }, { signal: sig });

    // Daily/Weekly/Monthly/Yearly rollup switcher for the "Trade
    // distribution & performance by <period>" charts -- same underlying
    // aggregation as before (renderPeriodDistPerf), just grouped by a
    // different date-key. Routed through applyReportFiltersAndRender()
    // (not called directly) so a timeframe switch still respects
    // whatever report filters (symbol/setup/duration/date/etc.) are active.
    const periodSelect = document.getElementById("report-period-select");
    if (periodSelect) {
      periodSelect.value = reportPeriodTimeframe;
      periodSelect.addEventListener("change", () => {
        reportPeriodTimeframe = periodSelect.value;
        applyReportFiltersAndRender();
      }, { signal: sig });
    }
  }
  // Phone: the headline numbers for the filtered set, shown above the tabs.
  function renderReportKpis() {
    const el = document.getElementById("rpt-kpis");
    if (!el) return;
    const list = App.state.trades;
    if (!list.length) { el.innerHTML = '<div class="kpi" style="grid-column:1/-1"><div class="l">No trades match these filters</div></div>'; return; }
    const st = App.computeStats(list);
    const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
    const pf = st.profitFactor === Infinity ? "\u221e" : st.profitFactor.toFixed(2);
    const k = (l, n, c) => `<div class="kpi"><div class="l">${l}</div><div class="n ${c || ""}">${n}</div></div>`;
    el.innerHTML = k("Net P&amp;L", fmtMoney(st.netPnl), cls(st.netPnl)) + k("Win rate", st.winRate.toFixed(0) + "%") + k("Profit factor", pf) + k("Trades", String(st.count));
  }
  function renderReports() {
    drillRegistry.clear(); // parked trade lists belong to the pass that made them
    App.safeRender(renderReportKpis, "renderReportKpis");
    updateFiltersToggle();
    // Each of these owns its own, unrelated slice of the page (a
    // different tab/panel's worth of divs) -- one throwing on some
    // edge-case field shouldn't stop the other fifteen from running.
    // See safeRender()'s comment near the top of this file for why.
    App.safeRender(renderDetailedStats, "renderDetailedStats");
    App.safeRender(renderDetailSubtabs, "renderDetailSubtabs");
    App.safeRender(renderPeriodDistPerf, "renderPeriodDistPerf");
    App.safeRender(renderOverviewCumulativePnl, "renderOverviewCumulativePnl");
    App.safeRender(renderStreaks, "renderStreaks");
    App.safeRender(renderHighlights, "renderHighlights");
    App.safeRender(renderSymbolBreakdown, "renderSymbolBreakdown");
    App.safeRender(renderDowBreakdown, "renderDowBreakdown");
    App.safeRender(renderTimeOfDayBreakdown, "renderTimeOfDayBreakdown");
    App.safeRender(renderDurationBreakdown, "renderDurationBreakdown");
    App.safeRender(renderSectorCountryBreakdown, "renderSectorCountryBreakdown");
    App.safeRender(renderWinLossDays, "renderWinLossDays");
    App.safeRender(renderDrawdown, "renderDrawdown");
    App.safeRender(renderCompare, "renderCompare");
    App.safeRender(renderTagBreakdown, "renderTagBreakdown");
    App.safeRender(renderAdvanced, "renderAdvanced");
    App.safeRender(renderInsights, "renderInsights");
  }
  // The actual trades behind each streak (trades are already chronological):
  // longest win run, longest loss run, and the run you're in right now.
  function streakInfo(list) {
    let bestWin = [], bestLoss = [], cur = [], curWin = null;
    list.forEach((t) => {
      const w = Boolean(t.win);
      if (cur.length && curWin === w) cur.push(t);
      else { cur = [t]; curWin = w; }
      if (w && cur.length > bestWin.length) bestWin = cur.slice();
      if (!w && cur.length > bestLoss.length) bestLoss = cur.slice();
    });
    return { bestWin, bestLoss, current: cur };
  }
  function renderStreaks() {
    // trades already sorted chronologically
    let best = 0, worst = 0, curWinRun = 0, curLossRun = 0;
    let trailingSign = 0, trailingRun = 0;
    App.state.trades.forEach((t) => {
      if (t.win) { curWinRun++; curLossRun = 0; best = Math.max(best, curWinRun); }
      else { curLossRun++; curWinRun = 0; worst = Math.max(worst, curLossRun); }
      if (t.win === (trailingSign === 1)) { trailingRun++; }
      else { trailingSign = t.win ? 1 : -1; trailingRun = 1; }
    });
    const currentLabel = trailingSign === 1 ? `${trailingRun}W` : trailingSign === -1 ? `${trailingRun}L` : "—";
    const currentColor = trailingSign === 1 ? "up" : trailingSign === -1 ? "down" : "";

    const si = streakInfo(App.state.trades);
    document.getElementById("streak-strip").innerHTML = `
      <div class="cell"${drillAttr("Current streak: " + currentLabel, si.current, { sub: "The run you're in right now", order: "chrono", calc: runCalc(si.current, currentLabel) })}><div class="label">Current streak</div><div class="value ${currentColor}">${currentLabel}</div></div>
      <div class="cell"${drillAttr("Best win streak: " + best + "W", si.bestWin, { sub: "Longest run of winners, oldest first", order: "chrono", calc: runCalc(si.bestWin, "Winning streak") })}><div class="label">Best win streak</div><div class="value up">${best}W</div></div>
      <div class="cell"${drillAttr("Worst loss streak: " + worst + "L", si.bestLoss, { sub: "Longest run of losers, oldest first", order: "chrono", calc: runCalc(si.bestLoss, "Losing streak") })}><div class="label">Worst loss streak</div><div class="value down">${worst}L</div></div>
    `;
  }
  function renderHighlights() {
    // Filters (symbol / Advanced) can leave zero trades -- reduce() with a
    // missing initial value used to throw on that.
    if (!App.state.trades.length) {
      document.getElementById("highlight-pair").innerHTML = `<div class="empty-state small">No trades match these filters.</div>`;
      return;
    }
    const best = App.state.trades.reduce((a, b) => (b.pnl_after_comm > a.pnl_after_comm ? b : a), App.state.trades[0]);
    const worst = App.state.trades.reduce((a, b) => (b.pnl_after_comm < a.pnl_after_comm ? b : a), App.state.trades[0]);
    document.getElementById("highlight-pair").innerHTML = `
      <a class="highlight-card best" href="trade.html?id=${encodeURIComponent(best.id)}" style="text-decoration:none;">
        <div class="label">Best trade</div>
        <div class="sym">${escapeHtml(best.symbol)} <span class="dim" style="font-weight:400;font-size:12px;">${escapeHtml(best.trade_date)}</span></div>
        <div class="pnl up">${fmtMoney(best.pnl_after_comm)}</div>
      </a>
      <a class="highlight-card worst" href="trade.html?id=${encodeURIComponent(worst.id)}" style="text-decoration:none;">
        <div class="label">Worst trade</div>
        <div class="sym">${escapeHtml(worst.symbol)} <span class="dim" style="font-weight:400;font-size:12px;">${escapeHtml(worst.trade_date)}</span></div>
        <div class="pnl down">${fmtMoney(worst.pnl_after_comm)}</div>
      </a>
    `;
  }
  function renderSymbolBreakdown() {
    const bySym = new Map();
    App.state.trades.forEach((t) => {
      if (!bySym.has(t.symbol)) bySym.set(t.symbol, { trades: [], net: 0 });
      const e = bySym.get(t.symbol);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    const rows = Array.from(bySym.entries()).sort((a, b) => b[1].net - a[1].net);
    const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r[1].net)));

    renderPaginatedBreakdownTable("report-symbol", rows, "Symbol", ([sym, e]) => {
      const winRate = (e.trades.filter((t) => t.win).length / e.trades.length) * 100;
      const pct = (Math.abs(e.net) / maxAbs) * 100;
      const color = e.net >= 0 ? "var(--green)" : "var(--red)";
      const smallSample = e.trades.length < 3;
      return `<tr class="report-row"${drillAttr(sym, e.trades, { row: true, sub: "By symbol" })}>
        <td style="font-weight:600;">${escapeHtml(sym)}${smallSample ? ` <span class="pill" style="font-size:9.5px; padding:1px 6px;" title="Fewer than 3 trades — win rate isn't meaningful yet.">n=${e.trades.length}</span>` : ""}</td>
        <td class="mono dim">${e.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${e.net >= 0 ? "up" : "down"}">${fmtMoney(e.net)}</span></td>
      </tr>`;
    });
  }
  function renderDowBreakdown() {
    const byDow = new Map();
    App.state.trades.forEach((t) => {
      const dow = new Date(t.trade_date + "T12:00:00").getDay();
      if (!byDow.has(dow)) byDow.set(dow, { trades: [], net: 0 });
      const e = byDow.get(dow);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    const order = [1, 2, 3, 4, 5, 0, 6]; // Mon..Sun
    const present = order.filter((d) => byDow.has(d));
    const maxAbs = Math.max(1, ...present.map((d) => Math.abs(byDow.get(d).net)));

    const html = present.map((d) => {
      const e = byDow.get(d);
      const winRate = (e.trades.filter((t) => t.win).length / e.trades.length) * 100;
      const pct = (Math.abs(e.net) / maxAbs) * 100;
      const color = e.net >= 0 ? "var(--green)" : "var(--red)";
      return `<tr class="report-row"${drillAttr(DOW[d], e.trades, { row: true, sub: "By day of week" })}>
        <td style="font-weight:600;">${DOW[d]}</td>
        <td class="mono dim">${e.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${e.net >= 0 ? "up" : "down"}">${fmtMoney(e.net)}</span></td>
      </tr>`;
    }).join("");

    const dowEl = document.getElementById("report-dow");
    dowEl.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">Day</th><th scope="col">Trades</th><th scope="col">Win %</th><th scope="col">Net P&amp;L</th></tr></thead><tbody>${html}</tbody></table></div>`;
    bindTradeToggles(dowEl);
  }
  // Buckets by ENTRY time, on the theory that when you got in is the
  // habit worth watching (chasing the open, forcing trades at lunch, etc).
  // Times are "HH:MM:SS" strings, which sort/compare correctly as text.
  const TOD_BUCKETS = [
    { label: "Open (9:30–9:45)", from: "09:30:00", to: "09:44:59" },
    { label: "Early (9:45–10:30)", from: "09:45:00", to: "10:29:59" },
    { label: "Mid-morning (10:30–11:30)", from: "10:30:00", to: "11:29:59" },
    { label: "Midday (11:30–14:00)", from: "11:30:00", to: "13:59:59" },
    { label: "Power hour (14:00–15:30)", from: "14:00:00", to: "15:29:59" },
    { label: "Close (15:30–16:00)", from: "15:30:00", to: "16:00:00" },
  ];
  function renderTimeOfDayBreakdown() {
    const buckets = TOD_BUCKETS.map((b) => ({ ...b, trades: [] }));
    const other = [];
    App.state.trades.forEach((t) => {
      const bucket = buckets.find((b) => t.entry_time >= b.from && t.entry_time <= b.to);
      if (bucket) bucket.trades.push(t);
      else other.push(t);
    });
    const present = buckets.filter((b) => b.trades.length);
    const maxAbs = Math.max(1, ...present.map((b) => Math.abs(b.trades.reduce((s, t) => s + t.pnl_after_comm, 0))));

    const rows = present.map((b) => {
      const net = b.trades.reduce((s, t) => s + t.pnl_after_comm, 0);
      const winRate = (b.trades.filter((t) => t.win).length / b.trades.length) * 100;
      const pct = (Math.abs(net) / maxAbs) * 100;
      const color = net >= 0 ? "var(--green)" : "var(--red)";
      return `<tr class="report-row"${drillAttr(b.label, b.trades, { row: true, sub: "By entry time" })}>
        <td style="font-weight:600;">${b.label}</td>
        <td class="mono dim">${b.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${net >= 0 ? "up" : "down"}">${fmtMoney(net)}</span></td>
      </tr>`;
    }).join("");

    const el = document.getElementById("report-timeofday");
    if (!rows) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    el.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">Session</th><th scope="col">Trades</th><th scope="col">Win %</th><th scope="col">Net P&amp;L</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    bindTradeToggles(el);
  }
  const DURATION_BUCKETS = [
    { label: "< 5 min", max: 5 },
    { label: "5–15 min", max: 15 },
    { label: "15–30 min", max: 30 },
    { label: "30–60 min", max: 60 },
    { label: "> 60 min", max: Infinity },
  ];
  function renderDurationBreakdown() {
    const buckets = DURATION_BUCKETS.map((b) => ({ ...b, trades: [] }));
    App.state.trades.forEach((t) => {
      const mins = App.durationMinutes(t);
      if (mins === null) return;
      const bucket = buckets.find((b) => mins <= b.max);
      (bucket || buckets[buckets.length - 1]).trades.push(t);
    });
    const maxCount = Math.max(1, ...buckets.map((b) => b.trades.length));

    const rows = buckets.filter((b) => b.trades.length).map((b) => {
      const winRate = (b.trades.filter((t) => t.win).length / b.trades.length) * 100;
      const pct = (b.trades.length / maxCount) * 100;
      return `<div class="bar-row"${drillAttr(b.label, b.trades, { sub: "Hold time" })}>
        <div class="bar-label">${b.label}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(0)}%;"></div></div>
        <div class="bar-count">${b.trades.length}x</div>
        <div style="width:52px; text-align:right; flex-shrink:0; color:${winRate >= 50 ? "var(--green)" : "var(--red)"};">${winRate.toFixed(0)}%</div>
      </div>`;
    }).join("");

    const el = document.getElementById("report-duration");
    const used = buckets.filter((b) => b.trades.length).length;
    // One bar holding every trade says nothing a trade count doesn't -- say so instead of drawing it.
    el.innerHTML = used > 1 ? rows : used === 1
      ? `<div class="empty-state small">Every trade with a hold time falls in ${escapeHtml(buckets.find((b) => b.trades.length).label)}.</div>`
      : `<div class="empty-state small">No data yet.</div>`;
    bindTradeToggles(el);
  }
  function symbolAgg() {
    const map = new Map();
    App.state.trades.forEach((t) => {
      if (!map.has(t.symbol)) map.set(t.symbol, { trades: [], net: 0 });
      const e = map.get(t.symbol);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    return map;
  }
  function leaderboardRows(entries, valueFn, valueCls) {
    return entries.map(([sym, e]) => {
      return `
      <div class="bar-row"${drillAttr(sym, e.trades, { sub: "Symbol" })}>
        <div class="bar-label" style="width:70px;">${escapeHtml(sym)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${e._pct}%;"></div></div>
        <div style="width:70px; text-align:right; flex-shrink:0;" class="${valueCls(e)}">${valueFn(e)}</div>
      </div>`;
    }).join("");
  }
  function renderLeaderboards() {
    const map = symbolAgg();
    const entries = Array.from(map.entries());

    const byCount = entries.slice().sort((a, b) => b[1].trades.length - a[1].trades.length).slice(0, 5);
    const maxCount = Math.max(1, ...byCount.map(([, e]) => e.trades.length));
    byCount.forEach(([, e]) => (e._pct = Math.round((e.trades.length / maxCount) * 100)));
    const mostTradedEl = document.getElementById("report-most-traded");
    mostTradedEl.innerHTML =
      leaderboardRows(byCount, (e) => `${e.trades.length}x`, () => "dim") || `<div class="empty-state small">No data yet.</div>`;
    bindTradeToggles(mostTradedEl);

    const byNet = entries.slice().sort((a, b) => b[1].net - a[1].net).slice(0, 5);
    const maxAbsNet = Math.max(1, ...byNet.map(([, e]) => Math.abs(e.net)));
    byNet.forEach(([, e]) => (e._pct = Math.round((Math.abs(e.net) / maxAbsNet) * 100)));
    const mostProfitableEl = document.getElementById("report-most-profitable");
    mostProfitableEl.innerHTML =
      leaderboardRows(byNet, (e) => fmtMoney(e.net), (e) => (e.net >= 0 ? "up" : "down")) || `<div class="empty-state small">No data yet.</div>`;
    bindTradeToggles(mostProfitableEl);
  }
  // sector/country aren't in the documented index schema today (only
  // trade detail files carry symbol_info) -- this reads them from the
  // index row IF the publish step has been extended to copy them over
  // (same pattern as setup_type/lesson_tags), and just shows an empty
  // state otherwise rather than fetching every detail file to fill the
  // gap, which would defeat the whole point of the index existing.
  function groupByField(field) {
    const map = new Map();
    let anyPresent = false;
    App.state.trades.forEach((t) => {
      if (!t[field]) return;
      anyPresent = true;
      if (!map.has(t[field])) map.set(t[field], { trades: [], net: 0 });
      const e = map.get(t[field]);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    return anyPresent ? map : null;
  }
  function renderBreakdownTable(elId, map, colLabel) {
    if (!map) {
      const el = document.getElementById(elId);
      if (el) el.innerHTML = `<div class="empty-state small">No ${escapeHtml(colLabel.toLowerCase())} data on these trades yet.</div>`;
      return;
    }
    const rows = Array.from(map.entries()).sort((a, b) => b[1].net - a[1].net);
    const maxAbs = Math.max(1, ...rows.map(([, e]) => Math.abs(e.net)));
    renderPaginatedBreakdownTable(elId, rows, colLabel, ([key, e]) => {
      const winRate = (e.trades.filter((t) => t.win).length / e.trades.length) * 100;
      const pct = (Math.abs(e.net) / maxAbs) * 100;
      const color = e.net >= 0 ? "var(--green)" : "var(--red)";
      return `<tr class="report-row"${drillAttr(key, e.trades, { row: true, sub: colLabel })}>
        <td style="font-weight:600;">${escapeHtml(key)}</td>
        <td class="mono dim">${e.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${e.net >= 0 ? "up" : "down"}">${fmtMoney(e.net)}</span></td>
      </tr>`;
    });
  }
  function renderSectorCountryBreakdown() {
    renderBreakdownTable("report-sector", groupByField("sector"), "Sector");
    renderBreakdownTable("report-country", groupByField("country"), "Country");
  }
  function dailyAgg() {
    const map = new Map();
    App.state.trades.forEach((t) => {
      if (!map.has(t.trade_date)) map.set(t.trade_date, { trades: [], net: 0 });
      const e = map.get(t.trade_date);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    return map;
  }
  function dayTableHtml(days) {
    if (!days.length) return `<div class="empty-state small">No data yet.</div>`;
    const rows = days.map((d) => {
      return `<tr class="report-row"${drillAttr(d.date, d.trades, { row: true, sub: "Trading day" })}>
        <td style="font-weight:600;">${d.date}</td>
        <td class="mono dim">${d.count}</td>
        <td class="mono ${d.net >= 0 ? "up" : "down"}">${fmtMoney(d.net)}</td>
      </tr>`;
    }).join("");
    return `<div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">Date</th><th scope="col">Trades</th><th scope="col">Net P&amp;L</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function renderWinLossDays() {
    const map = dailyAgg();
    const days = Array.from(map.entries()).map(([date, e]) => ({ date, net: e.net, count: e.trades.length, trades: e.trades }));
    const summaryEl = document.getElementById("wld-summary");
    if (!days.length) {
      summaryEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      document.getElementById("wld-top-win").innerHTML = `<div class="empty-state small">No data yet.</div>`;
      document.getElementById("wld-top-loss").innerHTML = `<div class="empty-state small">No data yet.</div>`;
      return;
    }
    const winDays = days.filter((d) => d.net > 0);
    const lossDays = days.filter((d) => d.net < 0);
    const avg = (arr) => (arr.length ? arr.reduce((s, d) => s + d.net, 0) / arr.length : 0);

    const winDayTrades = winDays.flatMap((d) => d.trades), lossDayTrades = lossDays.flatMap((d) => d.trades);
    summaryEl.innerHTML = `
      <div class="streak-strip" style="grid-template-columns:repeat(4,1fr);">
        <div class="cell"><div class="label">Winning days</div><div class="value up">${winDays.length} (${((winDays.length / days.length) * 100).toFixed(0)}%)</div></div>
        <div class="cell"><div class="label">Losing days</div><div class="value down">${lossDays.length} (${((lossDays.length / days.length) * 100).toFixed(0)}%)</div></div>
        <div class="cell"><div class="label">Avg win day</div><div class="value up">${fmtMoney(avg(winDays))}</div></div>
        <div class="cell"><div class="label">Avg loss day</div><div class="value down">${fmtMoney(avg(lossDays))}</div></div>
      </div>`;

    const winEl = document.getElementById("wld-top-win");
    winEl.innerHTML = dayTableHtml(winDays.slice().sort((a, b) => b.net - a.net).slice(0, 8));
    bindTradeToggles(winEl);
    const lossEl = document.getElementById("wld-top-loss");
    lossEl.innerHTML = dayTableHtml(lossDays.slice().sort((a, b) => a.net - b.net).slice(0, 8));
    bindTradeToggles(lossEl);
  }
  // Walks the equity curve (real account balance -- `_balance`, see
  // computeAccountBalances in auth.js; already chronological) tracking the
  // running peak. A drawdown "period" runs from the last new high to the
  // next new high (or to the end of the data if it hasn't recovered).
  function computeDrawdownStats() {
    const list = App.state.trades;
    if (!list.length) return null;
    let runPeak = list[0]._balance;
    let peakIdx = 0, troughIdx = 0; // indexes into `list`, so each period knows which trades it spans
    let inDD = false;
    const periods = [];
    let maxDD = 0, maxDDPeakIdx = 0, maxDDTroughIdx = 0;

    list.forEach((t, i) => {
      if (t._balance >= runPeak) {
        if (inDD) {
          periods.push({ peak: list[peakIdx], trough: list[troughIdx], recover: t, peakIdx, troughIdx, recoverIdx: i });
          inDD = false;
        }
        runPeak = t._balance;
        peakIdx = i;
        troughIdx = i;
      } else {
        inDD = true;
        if (t._balance < list[troughIdx]._balance) troughIdx = i;
      }
      const dd = t._balance - runPeak;
      if (dd < maxDD) { maxDD = dd; maxDDPeakIdx = peakIdx; maxDDTroughIdx = i; }
    });
    if (inDD) periods.push({ peak: list[peakIdx], trough: list[troughIdx], recover: null, peakIdx, troughIdx, recoverIdx: null });

    const last = list[list.length - 1];
    const currentDD = last._balance - runPeak;
    const maxDDPeak = list[maxDDPeakIdx], maxDDTrough = list[maxDDTroughIdx];
    const maxDDPct = maxDDPeak._balance !== 0 ? (maxDD / Math.abs(maxDDPeak._balance)) * 100 : null;

    periods.forEach((p) => {
      p.size = p.trough._balance - p.peak._balance;
      // The trades that dug the hole: everything after the peak, up to the trough.
      p.trades = list.slice(p.peakIdx + 1, p.troughIdx + 1);
    });
    periods.sort((a, b) => a.size - b.size);

    return {
      maxDD, maxDDPct, maxDDPeak, maxDDTrough, currentDD, periods,
      maxDDTrades: list.slice(maxDDPeakIdx + 1, maxDDTroughIdx + 1),
      currentTrades: currentDD < 0 ? list.slice(peakIdx + 1) : [],
      // Every trade taken while underwater (peak to recovery, or to today if still down).
      underwaterTrades: periods.reduce((acc, p) => acc.concat(list.slice(p.peakIdx + 1, p.recoverIdx == null ? list.length : p.recoverIdx)), []),
    };
  }
  function renderDrawdown() {
    renderCumulativeCharts();
    const d = computeDrawdownStats();
    const summaryEl = document.getElementById("dd-summary");
    const periodsEl = document.getElementById("dd-periods");
    if (!d) {
      summaryEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      periodsEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      return;
    }
    summaryEl.innerHTML = `
      <div class="streak-strip" style="grid-template-columns:repeat(3,1fr);">
        <div class="cell"${drillAttr("Max drawdown", d.maxDDTrades, { sub: `${d.maxDDPeak.trade_date} \u2192 ${d.maxDDTrough.trade_date} \u00b7 the trades between the peak and the bottom` })}><div class="label">Max drawdown</div><div class="value down">${fmtMoney(d.maxDD)}${d.maxDDPct != null ? ` (${d.maxDDPct.toFixed(1)}%)` : ""}</div></div>
        <div class="cell"${drillAttr("Current drawdown", d.currentTrades, { sub: "Every trade since your last equity high" })}><div class="label">Current drawdown</div><div class="value ${d.currentDD < 0 ? "down" : ""}">${d.currentDD < 0 ? fmtMoney(d.currentDD) : "At peak"}</div></div>
        <div class="cell"><div class="label">Number of drawdowns</div><div class="value">${d.periods.length}</div></div>
      </div>`;

    if (!d.periods.length) {
      periodsEl.innerHTML = `<div class="empty-state small">No drawdown periods — equity has only made new highs.</div>`;
      return;
    }
    const rows = d.periods.slice(0, 10).map((p) => `<tr${drillAttr(`Drawdown ${p.peak.trade_date} \u2192 ${p.trough.trade_date}`, p.trades, { row: true, sub: `${fmtMoney(p.size)} \u00b7 trades from the peak down to the trough` })}>
        <td><a href="trade.html?id=${encodeURIComponent(p.peak.id)}">${p.peak.trade_date} <span class="dim" style="font-size:11px;">(${fmtMoney(p.peak._balance)})</span></a></td>
        <td><a href="trade.html?id=${encodeURIComponent(p.trough.id)}">${p.trough.trade_date} <span class="dim" style="font-size:11px;">(${fmtMoney(p.trough._balance)})</span></a></td>
        <td class="mono down">${fmtMoney(p.size)}</td>
        <td>${p.recover ? `<a href="trade.html?id=${encodeURIComponent(p.recover.id)}">${p.recover.trade_date}</a>` : `<span class="dim">Ongoing</span>`}</td>
      </tr>`).join("");
    periodsEl.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">Peak</th><th scope="col">Trough</th><th scope="col">Drawdown</th><th scope="col">Recovered</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function periodStats(startDate, endDate) {
    if (!startDate || !endDate) return null;
    const subset = App.state.trades.filter((t) => t.trade_date >= startDate && t.trade_date <= endDate);
    if (!subset.length) return null;
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const wins = subset.filter((t) => t.win);
    const losses = subset.filter((t) => !t.win);
    const sum = (arr, f) => arr.reduce((s, t) => s + f(t), 0);
    const net = sum(subset, (t) => num(t.pnl_after_comm));
    const gross = sum(subset, (t) => num(t.pnl_before_comm));
    const commissions = sum(subset, (t) => num(t.commission));
    const winRate = (wins.length / subset.length) * 100;
    const grossWinSum = sum(wins, (t) => num(t.pnl_after_comm));
    const lossSum = sum(losses, (t) => num(t.pnl_after_comm));
    // null (shown as "—") when the period has no winners / no losers, rather than a fake $0.00.
    const avgWin = wins.length ? grossWinSum / wins.length : null;
    const avgLoss = losses.length ? lossSum / losses.length : null;
    const grossLossSum = Math.abs(lossSum);
    // Break-even win rate for this period's payoff (avg win vs avg loss) and how far the actual win rate is from it.
    const breakeven = avgWin != null && avgLoss != null && avgWin > 0 && avgLoss < 0 ? (-avgLoss / (avgWin - avgLoss)) * 100 : null;
    const profitFactor = grossLossSum > 0 ? grossWinSum / grossLossSum : (grossWinSum > 0 ? Infinity : 0);
    const payoffRatio = avgWin != null && avgLoss != null && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null;
    const pnls = subset.map((t) => num(t.pnl_after_comm));
    // reduce, not Math.max(...arr): spreading a very large array can overflow the call stack.
    const maxOf = (arr) => arr.reduce((m, v) => (v > m ? v : m), -Infinity);
    const minOf = (arr) => arr.reduce((m, v) => (v < m ? v : m), Infinity);
    // Per-day nets, for the day-level rows (best/worst day, winning-day %).
    const byDay = new Map();
    subset.forEach((t) => byDay.set(t.trade_date, (byDay.get(t.trade_date) || 0) + num(t.pnl_after_comm)));
    const dayNets = Array.from(byDay.values());
    const holds = subset.map((t) => App.durationMinutes(t)).filter((m) => m != null);
    // Trade sets behind the special rows (best/worst day, biggest win...), for click-through.
    const dayEntries = Array.from(byDay.entries());
    const pickDay = (better) => {
      const e = dayEntries.reduce((m, x) => (better(x[1], m[1]) ? x : m), dayEntries[0]);
      return subset.filter((t) => t.trade_date === e[0]);
    };
    const sets = {
      wins, losses,
      bestWin: subset.filter((t) => num(t.pnl_after_comm) === maxOf(pnls)),
      worstLoss: subset.filter((t) => num(t.pnl_after_comm) === minOf(pnls)),
      bestDay: pickDay((a, b) => a > b),
      worstDay: pickDay((a, b) => a < b),
      winDays: subset.filter((t) => byDay.get(t.trade_date) > 0),
    };
    return {
      trades: subset, sets,
      n: subset.length,
      days: dayNets.length,
      net, gross, commissions, winRate, avgWin, avgLoss, profitFactor, payoffRatio,
      breakeven, cushion: breakeven == null ? null : winRate - breakeven,
      expectancy: net / subset.length,
      largestWin: maxOf(pnls),
      largestLoss: minOf(pnls),
      tradesPerDay: subset.length / dayNets.length,
      avgPerDay: net / dayNets.length,
      winningDayPct: (dayNets.filter((d) => d > 0).length / dayNets.length) * 100,
      bestDay: maxOf(dayNets),
      worstDay: minOf(dayNets),
      avgHold: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
      avgShares: sum(subset, (t) => num(t.shares)) / subset.length,
    };
  }
  // One row per metric. `better` says which direction of change is good
  // ("up" = higher is better, "down" = lower is better, null = neutral, so
  // the Change column only colors a difference when it clearly helps or
  // hurts). Every metric here is signed such that "higher = better" holds
  // except commissions.
  const COMPARE_ROWS = [
    { label: "Trading days", key: "days", kind: "int" },
    { label: "Trades", key: "n", kind: "int" },
    { label: "Trades per day", key: "tradesPerDay", kind: "dec1" },
    { label: "Net P&amp;L", key: "net", kind: "money", better: "up", bold: true },
    { label: "Gross P&amp;L", key: "gross", kind: "money", better: "up" },
    { label: "Commissions", key: "commissions", kind: "moneyAbs", better: "down" },
    { label: "Avg P&amp;L per day", key: "avgPerDay", kind: "money", better: "up" },
    { label: "Win rate", key: "winRate", kind: "pct", better: "up" },
    { label: "Break-even win rate", key: "breakeven", kind: "pct", better: "down" },
    { label: "Win rate vs break-even", key: "cushion", kind: "pp", better: "up" },
    { label: "Winning days", key: "winningDayPct", kind: "pct", better: "up" },
    { label: "Avg win", key: "avgWin", kind: "money", better: "up" },
    { label: "Avg loss", key: "avgLoss", kind: "money", better: "up" },
    { label: "Win/loss ratio", key: "payoffRatio", kind: "dec2", better: "up" },
    { label: "Profit factor", key: "profitFactor", kind: "dec2", better: "up" },
    { label: "Expectancy per trade", key: "expectancy", kind: "money", better: "up" },
    { label: "Largest win", key: "largestWin", kind: "money", better: "up" },
    { label: "Largest loss", key: "largestLoss", kind: "money", better: "up" },
    { label: "Best day", key: "bestDay", kind: "money", better: "up" },
    { label: "Worst day", key: "worstDay", kind: "money", better: "up" },
    { label: "Avg hold time", key: "avgHold", kind: "duration" },
    { label: "Avg shares per trade", key: "avgShares", kind: "int" },
  ];
  function compareFormat(kind, v) {
    if (v == null || Number.isNaN(v)) return "\u2014";
    if (v === Infinity) return "\u221e";
    switch (kind) {
      case "int": return Math.round(v).toLocaleString();
      case "dec1": return v.toFixed(1);
      case "dec2": return v.toFixed(2);
      case "pct": return v.toFixed(1) + "%";
      case "pp": return (v >= 0 ? "+" : "\u2212") + Math.abs(v).toFixed(1) + " pts";
      case "money": return fmtMoney(v);
      case "moneyAbs": return "$" + v.toFixed(2);
      case "duration": return App.fmtDurationPrecise(v);
      default: return String(v);
    }
  }
  function compareDeltaHtml(row, a, b) {
    const av = a ? a[row.key] : null, bv = b ? b[row.key] : null;
    if (av == null || bv == null || !Number.isFinite(av) || !Number.isFinite(bv)) return `<span class="dim">\u2014</span>`;
    const diff = bv - av;
    if (Math.abs(diff) < 1e-9) return `<span class="dim">0</span>`;
    const sign = diff > 0 ? "+" : "-";
    const mag = Math.abs(diff);
    let text;
    switch (row.kind) {
      case "money": text = sign + "$" + mag.toFixed(2); break;
      case "moneyAbs": text = sign + "$" + mag.toFixed(2); break;
      case "pct": case "pp": text = sign + mag.toFixed(1) + " pp"; break;
      case "dec1": text = sign + mag.toFixed(1); break;
      case "dec2": text = sign + mag.toFixed(2); break;
      case "duration": text = sign + App.fmtDurationPrecise(mag); break;
      default: text = sign + Math.round(mag).toLocaleString();
    }
    let cls = "dim";
    if (row.better === "up") cls = diff > 0 ? "up" : "down";
    else if (row.better === "down") cls = diff > 0 ? "down" : "up";
    return `<span class="${cls}">${text}</span>`;
  }
  // Which trades a Compare cell should open: the specific winners / losers /
  // day behind the metric where there is one, otherwise the whole period.
  function compareSet(st, key) {
    switch (key) {
      case "avgWin": return st.sets.wins;
      case "avgLoss": return st.sets.losses;
      case "largestWin": return st.sets.bestWin;
      case "largestLoss": return st.sets.worstLoss;
      case "bestDay": return st.sets.bestDay;
      case "worstDay": return st.sets.worstDay;
      case "winningDayPct": return st.sets.winDays;
      default: return st.trades;
    }
  }
  function periodStatsHtml(a, b, ranges) {
    if (!a && !b) return `<div class="empty-state small">No trades in either date range.</div>`;
    const cell = (s, row, which) => {
      const txt = s ? compareFormat(row.kind, s[row.key]) : "\u2014";
      const da = ""; // compare cells: the period is already your own date range
      // Color the signed-money rows green/red by sign; everything else stays neutral.
      const cls = s && (row.kind === "money" || row.kind === "pp") && Number.isFinite(s[row.key]) ? (s[row.key] >= 0 ? " up" : " down") : "";
      return `<td class="mono num${cls}${row.bold ? " strong" : ""}"${da}>${txt}</td>`;
    };
    // The Change column opens both periods' trades for that metric together
    // (a trade that falls in both ranges is only listed once).
    const bothSets = (row) => {
      if (!a || !b) return [];
      const seen = new Set(), out = [];
      compareSet(a, row.key).concat(compareSet(b, row.key)).forEach((t) => {
        const k = t.id != null ? t.id : t;
        if (!seen.has(k)) { seen.add(k); out.push(t); }
      });
      return out;
    };
    const rows = COMPARE_ROWS.map((row) => `<tr>
        <td>${row.label}</td>${cell(a, row, "Period A")}${cell(b, row, "Period B")}
        <td class="mono num">${compareDeltaHtml(row, a, b)}</td>
      </tr>`).join("");
    const note = (!a || !b) ? `<div class="dim" style="font-size:12px;margin-bottom:8px;">No trades in ${!a ? "Period A" : "Period B"}'s date range.</div>` : "";
    return `${note}<div class="table-scroll"><table class="report-table compare-table"><thead><tr>
      <th scope="col">Metric</th>
      <th scope="col" class="num">Period A<span class="range">${escapeHtml(ranges.a)}</span></th>
      <th scope="col" class="num">Period B<span class="range">${escapeHtml(ranges.b)}</span></th>
      <th scope="col" class="num">Change (B vs A)</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function updateCompare() {
    const el = document.getElementById("compare-table");
    if (!el) return;
    const aS = document.getElementById("cmp-a-start").value, aE = document.getElementById("cmp-a-end").value;
    const bS = document.getElementById("cmp-b-start").value, bE = document.getElementById("cmp-b-end").value;
    el.innerHTML = periodStatsHtml(periodStats(aS, aE), periodStats(bS, bE), {
      a: aS && aE ? `${aS} \u2192 ${aE}` : "no range",
      b: bS && bE ? `${bS} \u2192 ${bE}` : "no range",
    });
  }
  function renderCompare() {
    if (!App.state.trades.length) { updateCompare(); return; }
    const aStartEl = document.getElementById("cmp-a-start");
    // Only seed defaults once — don't clobber a range the person already picked.
    if (aStartEl && !aStartEl.value) {
      const first = App.state.trades[0].trade_date, last = App.state.trades[App.state.trades.length - 1].trade_date;
      const midDate = App.state.trades[Math.floor(App.state.trades.length / 2)].trade_date;
      aStartEl.value = first;
      document.getElementById("cmp-a-end").value = midDate;
      document.getElementById("cmp-b-start").value = midDate;
      document.getElementById("cmp-b-end").value = last;
    }
    updateCompare();
  }
  function groupByTagArray(field) {
    const map = new Map();
    let any = false;
    App.state.trades.forEach((t) => {
      const tags = t[field];
      if (!tags || !tags.length) return;
      any = true;
      tags.forEach((tag) => {
        if (!map.has(tag)) map.set(tag, { trades: [], net: 0 });
        const e = map.get(tag);
        e.trades.push(t);
        e.net += t.pnl_after_comm;
      });
    });
    return any ? map : null;
  }
  function renderTagBreakdown() {
    renderBreakdownTable("tagb-setup", groupByField("setup_type"), "Setup");
    renderBreakdownTable("tagb-lessons", groupByTagArray("lesson_tags"), "Lesson tag");
  }
  function computeAdvancedStats() {
    if (!App.state.trades.length) return null;
    const s = App.computeStats();
    const n = App.state.trades.length;
    const commPctOfGross = s.grossPnl !== 0 ? (s.totalComm / Math.abs(s.grossPnl)) * 100 : null;
    const tradesPerDay = s.dayCount ? n / s.dayCount : null;

    const dayVals = Array.from(dailyAgg().values()).map((e) => e.net);
    const dayMean = dayVals.reduce((a, b) => a + b, 0) / dayVals.length;
    const daySd = stdev(dayVals);
    const dailySharpe = daySd ? dayMean / daySd : null;

    let curSign = 0, curStreakSum = 0, curStart = 0, bestWinStreakSum = 0, worstLossStreakSum = 0;
    let bwStart = -1, bwEnd = -1, wlStart = -1, wlEnd = -1; // where the best/worst $ streak sits in the list
    App.state.trades.forEach((t, i) => {
      const sign = t.pnl_after_comm >= 0 ? 1 : -1;
      if (sign === curSign) curStreakSum += t.pnl_after_comm;
      else { curSign = sign; curStreakSum = t.pnl_after_comm; curStart = i; }
      if (curSign === 1) {
        if (curStreakSum > bestWinStreakSum) { bestWinStreakSum = curStreakSum; bwStart = curStart; bwEnd = i; }
      } else if (curStreakSum < worstLossStreakSum) { worstLossStreakSum = curStreakSum; wlStart = curStart; wlEnd = i; }
    });

    const allHold = App.state.trades.map(App.durationMinutes).filter((v) => v != null);
    const avgHoldAll = allHold.length ? allHold.reduce((a, b) => a + b, 0) / allHold.length : null;

    return {
      commPctOfGross, tradesPerDay, dailySharpe, dayMean, daySd, bestWinStreakSum, worstLossStreakSum, avgHoldAll,
      bestWinStreakTrades: bwStart >= 0 ? App.state.trades.slice(bwStart, bwEnd + 1) : [],
      worstLossStreakTrades: wlStart >= 0 ? App.state.trades.slice(wlStart, wlEnd + 1) : [],
    };
  }
  function renderAdvanced() {
    const d = computeAdvancedStats();
    const el = document.getElementById("advanced-grid");
    if (!d) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    const all = App.state.trades;
    const paid = all.filter((t) => Number(t.commission) > 0);
    const s = App.computeStats();
    const withHold = all.filter((t) => App.durationMinutes(t) != null);
    const rows = [
      ["Commissions as % of Gross P&amp;L", d.commPctOfGross != null ? `<span class="v mono">${d.commPctOfGross.toFixed(1)}%</span>` : naCell("No gross P&L to compare against."), paid, "Trades that paid commission", { focus: "comm", calc: [["Commissions", "$" + s.totalComm.toFixed(2)], ["Gross P&L (before commissions)", dm(s.grossPnl)], ["Commissions as % of gross", d.commPctOfGross != null ? d.commPctOfGross.toFixed(1) + "%" : ""]] }],
      ["Avg Trades per Trading Day", d.tradesPerDay != null ? `<span class="v mono">${d.tradesPerDay.toFixed(1)}</span>` : naCell("No trading days recorded."), null, "Every trade in this view", { calc: [["Trades", String(all.length)], ["Trading days", String(s.dayCount)], ["Per day", d.tradesPerDay != null ? d.tradesPerDay.toFixed(1) : ""]] }],
      ["Daily Sharpe (un-annualized)", d.dailySharpe != null ? `<span class="v mono" title="Mean divided by standard deviation of daily net P&amp;L — not annualized, not risk-free-rate adjusted.">${d.dailySharpe.toFixed(2)}</span>` : naCell("Not enough trading days yet."), all, "Average day vs how much days swing", { collapse: true, calc: [["Trading days", String(s.dayCount)], ["Average day", dm(d.dayMean)], ["Std deviation of days", "$" + d.daySd.toFixed(2)], ["Sharpe", d.dailySharpe != null ? d.dailySharpe.toFixed(2) : ""]], note: "Average daily net P&L divided by its standard deviation. Not annualized." }],
      ["Best Win Streak ($)", `<span class="v up mono">${fmtMoney(d.bestWinStreakSum)}</span>`, d.bestWinStreakTrades, "The run of trades that made the most money", { order: "chrono", calc: runCalc(d.bestWinStreakTrades, "Run", true), note: "Listed oldest first — the run of winning trades that added up to the most money." }],
      ["Worst Loss Streak ($)", `<span class="v down mono">${fmtMoney(d.worstLossStreakSum)}</span>`, d.worstLossStreakTrades, "The run of trades that lost the most money", { order: "chrono", calc: runCalc(d.worstLossStreakTrades, "Run", true), note: "Listed oldest first — the run of losing trades that added up to the most lost." }],
      ["Average Hold Time (all trades)", `<span class="v mono">${fmtDuration(d.avgHoldAll)}</span>`, withHold, "Trades that have a hold time", { focus: "hold", calc: holdCalc(withHold, all.length) }],
    ];
    el.innerHTML = rows.map(([k, v, set, sub, extra]) => `<div class="stat-line"${set ? drillAttr(unescHtml(k), set, { sub, row: true, ...(extra || {}) }) : ""}><span class="k">${k}</span>${v}</div>`).join("");
  }
  // Small stats helpers shared by the grid below.
  function stdev(arr) {
    if (arr.length < 2) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(variance);
  }
  // Abramowitz-Stegun erf approximation, used only to turn a t-stat into
  // an approximate two-tailed p-value (normal approximation — fine for the
  // ballpark "how likely is this by chance" figure, not a rigorous test).
  function erf(x) {
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }
  function normalCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
  // Regression slope / standard-error-of-slope of the equity curve against
  // trade index — a rough, un-annualized "consistency of the equity curve"
  // figure in the same spirit as a K-Ratio, computed straight off
  // equity_after (nothing else in the schema tracks daily equity).
  function computeKRatio() {
    const y = App.state.trades.map((t) => t.equity_after);
    const n = y.length;
    if (n < 3) return null;
    const xMean = (n - 1) / 2;
    const yMean = y.reduce((s, v) => s + v, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (i - xMean) * (y[i] - yMean); sxx += (i - xMean) ** 2; }
    if (sxx === 0) return null;
    const slope = sxy / sxx;
    let ssRes = 0;
    for (let i = 0; i < n; i++) { const pred = yMean + slope * (i - xMean); ssRes += (y[i] - pred) ** 2; }
    const df = n - 2;
    if (df <= 0) return null;
    const se = Math.sqrt(ssRes / df);
    const seSlope = se / Math.sqrt(sxx);
    return seSlope === 0 ? null : slope / seSlope;
  }
  function computeDetailedStats() {
    const s = App.computeStats();
    const n = App.state.trades.length;
    const pnls = App.state.trades.map((t) => t.pnl_after_comm);
    const largestGain = Math.max(...pnls);
    const largestLoss = Math.min(...pnls);
    const avgDailyGainLoss = s.dayCount ? s.netPnl / s.dayCount : 0;
    const avgTradeGainLoss = n ? s.netPnl / n : 0;

    const perShare = App.state.trades.filter((t) => t.shares).map((t) => t.pnl_after_comm / t.shares);
    const avgPerShare = perShare.length ? perShare.reduce((a, b) => a + b, 0) / perShare.length : null;

    const scratch = App.state.trades.filter((t) => t.pnl_after_comm === 0);
    const avgOf = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    const holdWinAvg = avgOf(s.wins.map(App.durationMinutes).filter((v) => v != null));
    const holdLossAvg = avgOf(s.losses.map(App.durationMinutes).filter((v) => v != null));
    const holdScratchAvg = avgOf(scratch.map(App.durationMinutes).filter((v) => v != null));

    let bestWin = 0, bestLoss = 0, curWin = 0, curLoss = 0;
    App.state.trades.forEach((t) => {
      if (t.win) { curWin++; curLoss = 0; bestWin = Math.max(bestWin, curWin); }
      else { curLoss++; curWin = 0; bestLoss = Math.max(bestLoss, curLoss); }
    });

    const sd = stdev(pnls);
    const mean = n ? pnls.reduce((a, b) => a + b, 0) / n : 0;
    const sqn = n && sd ? Math.sqrt(n) * (mean / sd) : null;
    const tstat = n && sd ? mean / (sd / Math.sqrt(n)) : null;
    const pRandom = tstat != null ? 2 * (1 - normalCdf(Math.abs(tstat))) : null;

    const R = s.avgLoss !== 0 ? s.avgWin / Math.abs(s.avgLoss) : null;
    const winFrac = n ? s.wins.length / n : 0;
    const kelly = R ? (winFrac - (1 - winFrac) / R) * 100 : null;

    const kr = computeKRatio();

    return {
      ...s, n, largestGain, largestLoss, avgDailyGainLoss, avgTradeGainLoss, avgPerShare,
      scratchCount: scratch.length, holdWinAvg, holdLossAvg, holdScratchAvg,
      bestWin, bestLoss, sd, sqn, pRandom, kelly, kr,
    };
  }
  // ---- drill-down "how this number is made" helpers (Detailed / Advanced stat rows) ----
  const dm = (v) => fmtMoney(v);
  const dsum = (arr) => arr.reduce((a, t) => a + drillNum(t.pnl_after_comm), 0);
  // The run of trades behind a streak: how long, when, and what it made or lost.
  function runCalc(trades, noun, withCount) {
    if (!trades.length) return null;
    const first = trades.reduce((a, t) => (drillStamp(t) < drillStamp(a) ? t : a), trades[0]);
    const last = trades.reduce((a, t) => (drillStamp(t) > drillStamp(a) ? t : a), trades[0]);
    return [...(withCount ? [[noun, `${trades.length} in a row`]] : []), ["From", first.trade_date || "—"], ["To", last.trade_date || "—"], ["Net P&L", dm(dsum(trades))]];
  }
  function holdCalc(set, total) {
    const v = set.map(App.durationMinutes).filter((x) => x != null);
    if (!v.length) return null;
    const rows = [["Trades with a hold time", String(v.length)], ["Average hold", fmtDuration(v.reduce((a, b) => a + b, 0) / v.length)], ["Longest", fmtDuration(Math.max(...v))], ["Shortest", fmtDuration(Math.min(...v))]];
    if (total != null && total > v.length) rows.push(["Left out (no exit time)", String(total - v.length)]);
    return rows;
  }
  function moneyCell(v) {
    return `<span class="v mono ${v >= 0 ? "up" : "down"}">${fmtMoney(v)}</span>`;
  }
  function naCell(title) {
    return `<span class="v na" title="${escapeHtml(title)}">—</span>`;
  }
  function renderDetailedStats() {
    const d = computeDetailedStats();
    const winPct = d.n ? (d.wins.length / d.n) * 100 : 0;
    const lossPct = d.n ? (d.losses.length / d.n) * 100 : 0;

    // [label, value html, trades behind it, one-line note for the panel]
    const all = App.state.trades;
    const scratch = all.filter((t) => t.pnl_after_comm === 0);
    const withHold = (arr) => arr.filter((t) => App.durationMinutes(t) != null);
    const si = streakInfo(all);
    const mean = d.avgTradeGainLoss;
    const winSum = dsum(d.wins), lossSum = dsum(d.losses);
    const tstat = d.n && d.sd ? mean / (d.sd / Math.sqrt(d.n)) : null;
    const R = d.avgLoss !== 0 ? d.avgWin / Math.abs(d.avgLoss) : null;
    const wr = d.n ? (d.wins.length / d.n) * 100 : 0;
    const withShares = all.filter((t) => t.shares);
    const paid = all.filter((t) => Number(t.commission) > 0);
    const streakNote = (what) => `Listed oldest first \u2014 ${what}`;
    const rows = [
      ["Total Gain/Loss", moneyCell(d.netPnl), all, "Every trade in this view", { calc: [["Winners", dm(winSum)], ["Losers", dm(lossSum)], ["Net (after commissions)", dm(d.netPnl)]] }],
      ["Largest Gain", moneyCell(d.largestGain), all.filter((t) => t.pnl_after_comm === d.largestGain), "Your best trade"],
      ["Largest Loss", moneyCell(d.largestLoss), all.filter((t) => t.pnl_after_comm === d.largestLoss), "Your worst trade"],
      ["Average Daily Gain/Loss", moneyCell(d.avgDailyGainLoss), all, `Averaged over ${d.dayCount} trading day${d.dayCount === 1 ? "" : "s"}`, { calc: [["Net P&L", dm(d.netPnl)], ["Trading days", String(d.dayCount)], ["Per day", dm(d.avgDailyGainLoss)]] }],
      ["Average Daily Volume", naCell("Needs each symbol's daily market volume flattened onto data/trades.json — not in the schema yet.")],
      ["Average Per-share Gain/Loss", d.avgPerShare != null ? moneyCell(d.avgPerShare) : naCell("No trades with a share count."), withShares, "Trades with a share count", { focus: "share", calc: [["Trades with shares", String(withShares.length)], ["Average per share", d.avgPerShare != null ? dm(d.avgPerShare) : ""]], note: "Each trade's net P&L divided by its share count, then averaged." }],
      ["Average Trade Gain/Loss", moneyCell(d.avgTradeGainLoss), null, "Every trade in this view", { calc: [["Net P&L", dm(d.netPnl)], ["Trades", String(d.n)], ["Per trade", dm(mean)]] }],
      ["Average Winning Trade", moneyCell(d.avgWin), d.wins, "Winners", { calc: [["Winners", String(d.wins.length)], ["Total won", dm(winSum)], ["Average", dm(d.avgWin)]] }],
      ["Average Losing Trade", moneyCell(d.avgLoss), d.losses, "Losers", { calc: [["Losers", String(d.losses.length)], ["Total lost", dm(lossSum)], ["Average", dm(d.avgLoss)]] }],
      ["Total Number of Trades", `<span class="v">${d.n}</span>`, null, "Every trade in this view"],
      ["Number of Winning Trades", `<span class="v up">${d.wins.length} (${winPct.toFixed(1)}%)</span>`, null, "Winners", { calc: [["Winners", `${d.wins.length} of ${d.n}`], ["Win rate", winPct.toFixed(1) + "%"]] }],
      ["Number of Losing Trades", `<span class="v down">${d.losses.length} (${lossPct.toFixed(1)}%)</span>`, null, "Losers", { calc: [["Losers", `${d.losses.length} of ${d.n}`], ["Loss rate", lossPct.toFixed(1) + "%"]] }],
      ["Average Hold Time (scratch trades)", `<span class="v mono">${fmtDuration(d.holdScratchAvg)}</span>`, withHold(scratch), "Scratch trades that have a hold time", { focus: "hold", calc: holdCalc(scratch, scratch.length) }],
      ["Average Hold Time (winning trades)", `<span class="v mono">${fmtDuration(d.holdWinAvg)}</span>`, withHold(d.wins), "Winners that have a hold time", { focus: "hold", calc: holdCalc(d.wins, d.wins.length) }],
      ["Average Hold Time (losing trades)", `<span class="v mono">${fmtDuration(d.holdLossAvg)}</span>`, withHold(d.losses), "Losers that have a hold time", { focus: "hold", calc: holdCalc(d.losses, d.losses.length) }],
      ["Number of Scratch Trades", `<span class="v">${d.scratchCount}</span>`, scratch, "Trades that closed at exactly $0"],
      ["Max Consecutive Wins", `<span class="v up">${d.bestWin}</span>`, si.bestWin, "Your longest winning streak", { order: "chrono", calc: runCalc(si.bestWin, "Winning streak"), note: streakNote("the longest unbroken run of winners.") }],
      ["Max Consecutive Losses", `<span class="v down">${d.bestLoss}</span>`, si.bestLoss, "Your longest losing streak", { order: "chrono", calc: runCalc(si.bestLoss, "Losing streak"), note: streakNote("the longest unbroken run of losers.") }],
      ["Trade P&amp;L Standard Deviation", `<span class="v mono">$${d.sd.toFixed(2)}</span>`, all, "How spread out your trade results are", { collapse: true, calc: [["Average trade", dm(mean)], ["Standard deviation", "$" + d.sd.toFixed(2)], ["Typical trade lands between", `${dm(mean - d.sd)} and ${dm(mean + d.sd)}`], ["Trades", String(d.n)]], note: "A bigger number means your results swing more from trade to trade." }],
      ["System Quality Number (SQN)", d.sqn != null ? `<span class="v mono" title="PnL-based SQN, not R-multiple-based.">${d.sqn.toFixed(2)}</span>` : naCell("Not enough trades yet."), all, "Average trade vs how much results swing", { collapse: true, calc: [["Trades", String(d.n)], ["Average trade", dm(mean)], ["Standard deviation", "$" + d.sd.toFixed(2)], ["SQN", d.sqn != null ? d.sqn.toFixed(2) : ""]], note: "SQN = √trades × average trade ÷ standard deviation. Higher means a steadier edge." }],
      ["Probability of Random Chance", d.pRandom != null ? `<span class="v mono" title="Approximate — normal-approximation two-tailed p-value.">${(d.pRandom * 100).toFixed(1)}%</span>` : naCell("Not enough trades yet."), all, "How likely these results are luck", { collapse: true, calc: [["Trades", String(d.n)], ["Average trade", dm(mean)], ["t-statistic", tstat != null ? tstat.toFixed(2) : ""], ["Chance it's luck", d.pRandom != null ? (d.pRandom * 100).toFixed(1) + "%" : ""]], note: "The odds of an average this far from $0 if your trades had no real edge." }],
      ["Kelly Percentage", d.kelly != null ? `<span class="v mono">${d.kelly.toFixed(1)}%</span>` : naCell("Needs both wins and losses to compute."), all, "Bet size the win rate and payoff imply", { collapse: true, calc: [["Win rate", wr.toFixed(1) + "%"], ["Average win", dm(d.avgWin)], ["Average loss", dm(d.avgLoss)], ["Win / loss ratio", R != null ? R.toFixed(2) : ""], ["Kelly", d.kelly != null ? d.kelly.toFixed(1) + "%" : ""]], note: "Kelly = win rate − (1 − win rate) ÷ win/loss ratio." }],
      ["K-Ratio", d.kr != null ? `<span class="v mono" title="Trade-level, un-annualized.">${d.kr.toFixed(2)}</span>` : naCell("Not enough trades yet."), all, "How steadily your equity curve climbs", { collapse: true, calc: [["Trades", String(d.n)], ["K-Ratio", Number.isFinite(d.kr) ? d.kr.toFixed(2) : ""]], note: "The slope of your equity curve divided by how noisy it is. Higher means a smoother climb." }],
      ["Profit Factor", `<span class="v mono">${d.profitFactor === Infinity ? "∞" : d.profitFactor.toFixed(2)}</span>`, all, "Gross wins ÷ gross losses", { collapse: true, calc: [["Gross wins", dm(winSum)], ["Gross losses", dm(lossSum)], ["Profit factor", d.profitFactor === Infinity ? "∞" : d.profitFactor.toFixed(2)]], note: "Above 1.00 means winners outweigh losers in dollars." }],
      ["Total Commissions", `<span class="v mono">$${d.totalComm.toFixed(2)}</span>`, paid, "Trades that paid commission", { focus: "comm", calc: [["Total paid", "$" + d.totalComm.toFixed(2)], ["Trades that paid", String(paid.length)], ["Average per trade", paid.length ? "$" + (d.totalComm / paid.length).toFixed(2) : ""]] }],
      ["Total Fees", naCell("Only commission is tracked in the current schema — no separate fees field.")],
      ["Average Position MAE", naCell("Needs intrabar adverse-excursion tracking not in the current schema.")],
      ["Average Position MFE", naCell("Needs intrabar favorable-excursion tracking not in the current schema.")],
    ];

    document.getElementById("detailed-stat-grid").innerHTML = rows
      .map(([k, v, set, sub, extra]) => `<div class="stat-line"${set ? drillAttr(unescHtml(k), set, { sub, row: true, ...(extra || {}) }) : ""}><span class="k">${k}</span>${v}</div>`)
      .join("");
  }
  // ---------------------------------------------------------------
  // Shared bucket → report-table renderer for the sub-tabs below.
  // Takes [{label, trades:[...]}] and renders the same money/win%
  // table style as the existing symbol/day-of-week reports.
  // ---------------------------------------------------------------
  function bucketBreakdownTableHtml(buckets, labelHeader) {
    const present = buckets.filter((b) => b.trades.length);
    if (!present.length) return `<div class="empty-state small">No data yet.</div>`;
    const maxAbs = Math.max(1, ...present.map((b) => Math.abs(b.trades.reduce((s, t) => s + t.pnl_after_comm, 0))));
    const rows = present.map((b) => {
      const net = b.trades.reduce((s, t) => s + t.pnl_after_comm, 0);
      const winRate = (b.trades.filter((t) => t.win).length / b.trades.length) * 100;
      const pct = (Math.abs(net) / maxAbs) * 100;
      const color = net >= 0 ? "var(--green)" : "var(--red)";
      return `<tr class="report-row"${drillAttr(b.label, b.trades, { row: true, sub: labelHeader })}>
        <td style="font-weight:600;">${escapeHtml(b.label)}</td>
        <td class="mono dim">${b.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${net >= 0 ? "up" : "down"}">${fmtMoney(net)}</span></td>
      </tr>`;
    }).join("");
    return `<div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">${escapeHtml(labelHeader)}</th><th scope="col">Trades</th><th scope="col">Win %</th><th scope="col">Net P&amp;L</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  // bucketBreakdownTableHtml returns markup with the toggle rows baked in,
  // but the click handlers still need binding after each caller drops the
  // string into the DOM via innerHTML — this wraps that so every call site
  // gets the same treatment in one line.
  function setBucketBreakdownHtml(elId, buckets, labelHeader) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.innerHTML = bucketBreakdownTableHtml(buckets, labelHeader);
    bindTradeToggles(el);
  }
  function renderDetailSubtabs() {
    App.safeRender(renderDetailHour, "renderDetailHour");
    App.safeRender(renderDetailPrice, "renderDetailPrice");
    App.safeRender(renderDetailSize, "renderDetailSize");
    App.safeRender(renderDetailSymbolTop20Bottom20, "renderDetailSymbolTop20Bottom20");
    App.safeRender(renderDetailSide, "renderDetailSide");
    App.safeRender(renderDetailSetup, "renderDetailSetup");
    App.safeRender(renderDetailLessons, "renderDetailLessons");
    App.safeRender(renderDetailWinLossRatio, "renderDetailWinLossRatio");
    App.safeRender(renderDetailDistribution, "renderDetailDistribution");
    App.safeRender(renderDetailExpectancy, "renderDetailExpectancy");
    App.safeRender(renderDetailRvol, "renderDetailRvol");
    App.safeRender(renderDetailAvgVol, "renderDetailAvgVol");
    App.safeRender(() => renderBreakdownTable("detail-float", groupByField("float_tag"), "Float"), "renderBreakdownTable(detail-float)");
  }
  // ---- Days/Times ----
  function renderDetailDow() {
    const byDow = new Map();
    App.state.trades.forEach((t) => {
      const dow = new Date(t.trade_date + "T12:00:00").getDay();
      if (!byDow.has(dow)) byDow.set(dow, { label: DOW[dow], trades: [] });
      byDow.get(dow).trades.push(t);
    });
    const order = [1, 2, 3, 4, 5, 0, 6];
    const buckets = order.filter((d) => byDow.has(d)).map((d) => byDow.get(d));
    setBucketBreakdownHtml("detail-dow", buckets, "Day");
  }
  function renderDetailHour() {
    const map = new Map();
    App.state.trades.forEach((t) => {
      // No entry time -> no hour to put it in. Skip it rather than throw
      // (which used to blank this whole breakdown).
      if (typeof t.entry_time !== "string" || t.entry_time.length < 2) return;
      const label = t.entry_time.slice(0, 2) + ":00";
      if (!map.has(label)) map.set(label, { label, trades: [] });
      map.get(label).trades.push(t);
    });
    const buckets = Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
    setBucketBreakdownHtml("detail-hour", buckets, "Hour");
  }
  // ---- Price/Volume ----
  const PRICE_BUCKETS = [
    { label: "< $2", max: 2 }, { label: "$2 – $4.99", max: 4.99 }, { label: "$5 – $9.99", max: 9.99 },
    { label: "$10 – $19.99", max: 19.99 }, { label: "$20 – $49.99", max: 49.99 }, { label: "$50 – $99.99", max: 99.99 },
    { label: "$100 – $199.99", max: 199.99 }, { label: "$200 – $499.99", max: 499.99 }, { label: "$500+", max: Infinity },
  ];
  function renderDetailPrice() {
    const buckets = PRICE_BUCKETS.map((b) => ({ ...b, trades: [] }));
    App.state.trades.forEach((t) => {
      // A missing price would otherwise coerce to 0 and land in the "< $2"
      // bucket (null <= 2 is true), quietly skewing that row. Skip it.
      if (t.entry_price == null || !Number.isFinite(Number(t.entry_price))) return;
      const bucket = buckets.find((b) => t.entry_price <= b.max);
      (bucket || buckets[buckets.length - 1]).trades.push(t);
    });
    renderPairedHistogram("detail-price-dist", "detail-price-perf", buckets, { labelW: 96, context: "Entry price" });
  }
  const SIZE_BUCKETS = [
    { label: "< 20", max: 20 }, { label: "20 – 49", max: 49 }, { label: "50 – 99", max: 99 },
    { label: "100 – 500", max: 500 }, { label: "500 – 1,000", max: 1000 }, { label: "1,000 – 2,500", max: 2500 },
    { label: "2,500 – 5,000", max: 5000 }, { label: "5,000 – 10,000", max: 10000 }, { label: "10,000+", max: Infinity },
  ];
  function renderDetailSize() {
    const buckets = SIZE_BUCKETS.map((b) => ({ ...b, trades: [] }));
    App.state.trades.forEach((t) => {
      const bucket = buckets.find((b) => t.shares <= b.max);
      (bucket || buckets[buckets.length - 1]).trades.push(t);
    });
    renderPairedHistogram("detail-size-dist", "detail-size-perf", buckets, { labelW: 96, context: "Position size (shares)" });
  }
  // ---- Instrument ----
  function renderDetailSymbolTable() {
    const map = symbolAgg();
    const buckets = Array.from(map.entries())
      .map(([sym, e]) => ({ label: sym, trades: e.trades }))
      .sort((a, b) => b.trades.length - a.trades.length)
      .slice(0, 10);
    setBucketBreakdownHtml("detail-symbol", buckets, "Symbol");
  }
  // Performance by symbol, Top 20 / Bottom 20 by net P&L -- Tradervue's
  // signature Instrument-tab chart. Every symbol with at least one
  // trade is eligible; a symbol only ever appears on one side (its own
  // net P&L is either >= 0 or < 0, never both).
  function renderDetailSymbolTop20Bottom20() {
    const map = symbolAgg();
    const entries = Array.from(map.entries()).map(([sym, e]) => ({
      label: sym, net: e.net, trades: e.trades,
    }));
    const winners = entries.filter((e) => e.net >= 0).sort((a, b) => b.net - a.net).slice(0, 20);
    const losers = entries.filter((e) => e.net < 0).sort((a, b) => a.net - b.net).slice(0, 20).reverse();

    const chartFor = (elId, rows, color) => {
      const el = document.getElementById(elId);
      if (!el) return;
      if (!rows.length) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
      el.innerHTML = svgAxisBarChart(
        rows.map((r) => ({ label: r.label, value: r.net, color, trades: r.trades })),
        { fmt: fmtAxisMoney, labelW: 60, barHeight: 15, context: "Symbol" }
      );
    };
    chartFor("detail-symbol-top20", winners, "var(--green)");
    chartFor("detail-symbol-bottom20", losers, "var(--red)");
  }
  function renderDetailSide() {
    const map = new Map();
    App.state.trades.forEach((t) => {
      const side = t.side || "unknown";
      if (!map.has(side)) map.set(side, { label: side, trades: [] });
      map.get(side).trades.push(t);
    });
    setBucketBreakdownHtml("detail-side", Array.from(map.values()), "Side");
  }
  // ---- Market Behavior ----
  function renderDetailSetup() {
    const map = new Map();
    App.state.trades.forEach((t) => {
      if (!t.setup_type) return;
      if (!map.has(t.setup_type)) map.set(t.setup_type, { label: t.setup_type, trades: [] });
      map.get(t.setup_type).trades.push(t);
    });
    const buckets = Array.from(map.values()).sort((a, b) => b.trades.length - a.trades.length);
    setBucketBreakdownHtml("detail-setup", buckets, "Setup");
  }
  function renderDetailLessons() {
    const counts = new Map();
    App.state.trades.forEach((t) => (t.lesson_tags || []).forEach((tag) => {
      if (!counts.has(tag)) counts.set(tag, { count: 0, trades: [] });
      const e = counts.get(tag);
      e.count++;
      e.trades.push(t);
    }));
    const entries = Array.from(counts.entries()).sort((a, b) => b[1].count - a[1].count).slice(0, 8);
    const el = document.getElementById("detail-lessons");
    if (!entries.length) { el.innerHTML = `<div class="empty-state small">No lesson tags logged yet.</div>`; return; }
    const maxCount = Math.max(...entries.map(([, e]) => e.count));
    el.innerHTML = entries.map(([tag, e]) => {
      return `
      <div class="bar-row"${drillAttr(tag.replace(/_/g, " "), e.trades, { sub: "Lesson tag" })}>
        <div class="bar-label">${escapeHtml(tag.replace(/_/g, " "))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${((e.count / maxCount) * 100).toFixed(0)}%;"></div></div>
        <div class="bar-count">${e.count}x</div>
      </div>`;
    }).join("");
    bindTradeToggles(el);
  }
  // ---- Win/Loss/Expectation ----
  const PNL_BUCKETS = [
    { label: "< -$500", neg: true, test: (v) => v < -500 },
    { label: "-$500 to -$200", neg: true, test: (v) => v >= -500 && v < -200 },
    { label: "-$200 to -$50", neg: true, test: (v) => v >= -200 && v < -50 },
    { label: "-$50 to $0", neg: true, test: (v) => v >= -50 && v < 0 },
    { label: "$0 to $50", neg: false, test: (v) => v >= 0 && v < 50 },
    { label: "$50 to $200", neg: false, test: (v) => v >= 50 && v < 200 },
    { label: "$200 to $500", neg: false, test: (v) => v >= 200 && v < 500 },
    { label: "> $500", neg: false, test: (v) => v >= 500 },
  ];
  function renderDetailDistribution() {
    const buckets = PNL_BUCKETS.map((b) => ({ ...b, count: 0, trades: [] }));
    App.state.trades.forEach((t) => {
      const b = buckets.find((b) => b.test(t.pnl_after_comm));
      if (b) { b.count++; b.trades.push(t); }
    });
    const present = buckets.filter((b) => b.count);
    const el = document.getElementById("detail-distribution");
    if (!present.length) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    const maxCount = Math.max(...present.map((b) => b.count));
    el.innerHTML = present.map((b) => {
      return `
      <div class="bar-row"${drillAttr(b.label, b.trades, { sub: "Trade P&L range" })}>
        <div class="bar-label" style="width:130px;">${b.label}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${((b.count / maxCount) * 100).toFixed(0)}%;background:${b.neg ? "var(--red)" : "var(--green)"};"></div></div>
        <div class="bar-count">${b.count}x</div>
      </div>`;
    }).join("");
    bindTradeToggles(el);
  }
  // ---- Liquidity ----
  // relative_volume is a raw multiplier on each trade row (1.0 = 100% of
  // 30-day average volume) -- real numeric buckets, matching Tradervue's
  // own "% of Nd avg" scale.
  const RVOL_BUCKETS = [
    { label: "25% – 49%", max: 0.49 }, { label: "50% – 74%", max: 0.74 }, { label: "75% – 99%", max: 0.99 },
    { label: "100% – 124%", max: 1.24 }, { label: "125% – 149%", max: 1.49 }, { label: "150% – 199%", max: 1.99 },
    { label: "200% – 299%", max: 2.99 }, { label: "300% – 499%", max: 4.99 }, { label: "500%+", max: Infinity },
  ];
  function renderDetailRvol() {
    const withRvol = App.state.trades.filter((t) => typeof t.relative_volume === "number" && isFinite(t.relative_volume));
    const buckets = RVOL_BUCKETS.map((b) => ({ ...b, trades: [] }));
    const under = { label: "< 25%", trades: [] };
    withRvol.forEach((t) => {
      if (t.relative_volume < 0.25) { under.trades.push(t); return; }
      const bucket = buckets.find((b) => t.relative_volume <= b.max);
      (bucket || buckets[buckets.length - 1]).trades.push(t);
    });
    const all = under.trades.length ? [under, ...buckets] : buckets;
    renderPairedHistogram("detail-rvol-dist", "detail-rvol-perf", all, { labelW: 92, context: "Relative volume" });
  }
  // No raw 30-day-average-volume number is carried on the trades index
  // (only trade.js's per-trade detail fetch sees that) -- so this uses
  // the index's own avg_volume_tag categories rather than fabricating
  // Tradervue's exact dollar-volume tiers off data that isn't there.
  function renderDetailAvgVol() {
    const map = new Map();
    App.state.trades.forEach((t) => {
      if (!t.avg_volume_tag) return;
      if (!map.has(t.avg_volume_tag)) map.set(t.avg_volume_tag, []);
      map.get(t.avg_volume_tag).push(t);
    });
    const buckets = Array.from(map.entries()).map(([label, ts]) => ({ label: prettifyTag(label), trades: ts }));
    renderPairedHistogram("detail-avgvol-dist", "detail-avgvol-perf", buckets, { labelW: 92, context: "Average volume" });
  }
  // ---- Win/Loss/Expectation ----
  function renderDetailWinLossRatio() {
    const d = computeDetailedStats();
    const donutEl = document.getElementById("detail-winloss-donut");
    const cmpEl = document.getElementById("detail-winloss-compare");
    if (!donutEl || !cmpEl) return;
    if (!d.n) {
      donutEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      cmpEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      return;
    }
    const winPct = (d.wins.length / d.n) * 100;
    donutEl.innerHTML = svgDonutChart(winPct, { winTrades: d.wins, lossTrades: d.losses, allTrades: App.state.trades }) + `<div style="text-align:center; color:var(--text-faint); font-size:11.5px; margin-top:4px;"><span>${d.wins.length} wins</span> · <span>${d.losses.length} losses</span></div>`;
    const grossWin = d.wins.reduce((s, t) => s + t.pnl_after_comm, 0);
    const grossLoss = d.losses.reduce((s, t) => s + t.pnl_after_comm, 0);
    cmpEl.innerHTML = svgAxisBarChart(
      [{ label: "Gain", value: grossWin, color: "var(--green)", trades: d.wins, drillTitle: "Winning trades" }, { label: "Loss", value: grossLoss, color: "var(--red)", trades: d.losses, drillTitle: "Losing trades" }],
      { fmt: fmtAxisMoney, labelW: 56, barHeight: 34, context: "Gross gain vs gross loss" }
    );
  }
  function renderDetailExpectationBar() {
    const d = computeDetailedStats();
    const el = document.getElementById("detail-expectation-bar");
    if (!el) return;
    if (!d.n) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    const winRateFrac = d.wins.length / d.n, lossRateFrac = d.losses.length / d.n;
    const expectancy = winRateFrac * d.avgWin + lossRateFrac * d.avgLoss;
    el.innerHTML = svgAxisBarChart(
      [{ label: "Expectation", value: expectancy, color: expectancy >= 0 ? "var(--green)" : "var(--red)", trades: null }],
      { fmt: fmtAxisMoney, labelW: 84, barHeight: 34, context: "Expected P&L per trade" }
    ) + `<div style="text-align:center; color:var(--text-faint); font-size:11.5px; margin-top:2px;">Expected P&amp;L per trade</div>`;
  }
  function renderDetailExpectancy() {
    const d = computeDetailedStats();
    const el = document.getElementById("detail-expectancy");
    if (!d.n) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    const winRateFrac = d.wins.length / d.n;
    const lossRateFrac = d.losses.length / d.n;
    const expectancy = winRateFrac * d.avgWin + lossRateFrac * d.avgLoss;
    const ratio = d.avgLoss !== 0 ? d.avgWin / Math.abs(d.avgLoss) : null;
    const allT = App.state.trades;
    const R2 = d.avgLoss !== 0 ? d.avgWin / Math.abs(d.avgLoss) : null;
    const rows = [
      ["Avg win / avg loss ratio", ratio != null ? ratio.toFixed(2) : "—", allT, "How big your average win is next to your average loss", { collapse: true, calc: [["Average win", dm(d.avgWin)], ["Average loss", dm(d.avgLoss)], ["Ratio", ratio != null ? ratio.toFixed(2) : ""]] }],
      ["Expectancy per trade", fmtMoney(expectancy), allT, "What an average trade is worth", { collapse: true, calc: [["Win rate × average win", dm(winRateFrac * d.avgWin)], ["Loss rate × average loss", dm(lossRateFrac * d.avgLoss)], ["Expectancy", dm(expectancy)]] }],
    ];
    el.innerHTML = `<div class="kv-list">${rows.map(([k, v, set, sub, extra]) => `<div class="kv-row"${drillAttr(k, set, { sub, row: true, ...(extra || {}) })}><span class="k">${k}</span><span class="v">${v}</span></div>`).join("")}</div>`;
  }
  // Tradervue-style Daily/Weekly/Monthly/Yearly rollup switcher (see
  // #report-period-select). All four timeframes are the exact same
  // group-by-date-key-then-net-P&L aggregation Monthly already did --
  // only periodKey() below changes per timeframe. Monthly stays the
  // default so existing behavior/screenshots don't shift.
  const PERIOD_NOUN = { daily: "day", weekly: "week", monthly: "month", yearly: "year" };
  // Returns the bucket key + display label for one trade's trade_date
  // under the given timeframe. Weekly buckets by the Monday that starts
  // ISO week the trade falls in (labeled as that Monday's date, so bars
  // read left-to-right in real chronological order same as the other
  // timeframes) -- "T12:00:00" avoids the DST/UTC-rollover edge cases
  // the rest of this file already works around when parsing trade_date.
  function periodKey(dateStr, timeframe) {
    if (!dateStr) return null;
    if (timeframe === "yearly") return dateStr.slice(0, 4);
    if (timeframe === "monthly") return dateStr.slice(0, 7);
    if (timeframe === "daily") return dateStr;
    // weekly
    const d = new Date(dateStr + "T12:00:00");
    const dow = d.getDay(); // 0=Sun..6=Sat
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    d.setDate(d.getDate() + mondayOffset);
    return `${d.getFullYear()}-${App.pad2(d.getMonth() + 1)}-${App.pad2(d.getDate())}`;
  }
  function renderPeriodDistPerf() {
    const timeframe = reportPeriodTimeframe || "monthly";
    const noun = PERIOD_NOUN[timeframe] || "month";

    const labelEl = document.getElementById("report-period-label");
    if (labelEl) labelEl.innerHTML = `Trade distribution &amp; performance by ${noun}`;
    const distTitleEl = document.getElementById("report-period-dist-title");
    if (distTitleEl) distTitleEl.textContent = `Trade distribution by ${noun}`;
    const perfTitleEl = document.getElementById("report-period-perf-title");
    if (perfTitleEl) perfTitleEl.textContent = `Performance by ${noun}`;

    const map = new Map();
    App.state.trades.forEach((t) => {
      const key = periodKey(t.trade_date, timeframe);
      if (!key) return;
      if (!map.has(key)) map.set(key, { label: key, trades: [] });
      map.get(key).trades.push(t);
    });
    const buckets = Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
    renderPairedHistogram("report-month-dist", "report-month-perf", buckets, { labelW: 64, barHeight: 15, context: `By ${noun}` });
  }
  function renderCumulativeCharts() {
    const pnlEl = document.getElementById("dd-cum-pnl");
    const ddEl = document.getElementById("dd-cum-drawdown");
    if (!pnlEl || !ddEl) return;
    if (!App.state.trades.length) {
      pnlEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      ddEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      return;
    }
    // Use the real account balance (`_balance` -- Settings ledger +
    // cumulative P&L, see computeAccountBalances in auth.js) so a deposit
    // or withdrawal moves these charts the same way it already moves the
    // Max/Current drawdown figures and Drawdown periods table above.
    const startBalance = App.state.trades[0]._balance - (App.state.trades[0].pnl_after_comm || 0);
    const cumPnl = App.state.trades.map((t) => t._balance - startBalance);
    let runPeak = -Infinity;
    const drawdown = cumPnl.map((v) => { runPeak = Math.max(runPeak, v); return v - runPeak; });
    renderMiniLineChart(pnlEl, App.state.trades.map((t, i) => ({ x: t.trade_date, y: cumPnl[i] })), { trades: App.state.trades, context: "Cumulative P&L" });
    renderMiniLineChart(ddEl, App.state.trades.map((t, i) => ({ x: t.trade_date, y: drawdown[i] })), { trades: App.state.trades, context: "Drawdown from peak" });
  }
  // ================================================================
  // REPORTS — Overview: Cumulative P&L with its own 30/60/90/All toggle
  // (Detailed's Win/Loss/Expectation cumulative chart below reuses the
  // page's already-selected date range instead, since it sits alongside
  // panels that don't have their own toggle either.)
  // ================================================================
  let overviewCumRange = "90"; // "30" | "60" | "90" | "all"
  function overviewCumSubset() {
    if (overviewCumRange === "all" || !App.state.trades.length) return App.state.trades;
    const days = parseInt(overviewCumRange, 10);
    const anchor = new Date(App.state.trades[App.state.trades.length - 1].trade_date + "T12:00:00");
    const cutoff = new Date(anchor);
    cutoff.setDate(cutoff.getDate() - days);
    const subset = App.state.trades.filter((t) => new Date(t.trade_date + "T12:00:00") >= cutoff);
    return subset.length ? subset : App.state.trades;
  }
  function bindOverviewCumRangeToggle() {
    const wrap = document.getElementById("ov-cumpnl-range-toggle");
    if (!wrap || wrap.dataset.bound) return;
    wrap.dataset.bound = "1";
    wrap.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-range]");
      if (!btn) return;
      overviewCumRange = btn.dataset.range;
      wrap.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      renderOverviewCumulativePnl();
    }, { signal: App.signal });
  }
  function renderOverviewCumulativePnl() {
    bindOverviewCumRangeToggle();
    const el = document.getElementById("report-cum-pnl");
    if (!el) return;
    const subset = overviewCumSubset();
    if (!subset.length) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    let running = 0;
    const series = subset.map((t) => { running += t.pnl_after_comm; return { x: t.trade_date, y: running }; });
    renderMiniLineChart(el, series, { trades: subset, context: "Cumulative P&L" });
  }
  // Win/Loss/Expectation's own Cumulative P&L -- tracks whatever `trades`
  // currently holds (the page's overall date range / filters), same as
  // its sibling panels in that grid.
  function renderDetailCumulativePnl() {
    const el = document.getElementById("detail-cum-pnl");
    if (!el) return;
    if (!App.state.trades.length) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    let running = 0;
    const series = App.state.trades.map((t) => { running += t.pnl_after_comm; return { x: t.trade_date, y: running }; });
    renderMiniLineChart(el, series, { trades: App.state.trades, context: "Cumulative P&L" });
  }

  // =====================================================================
  // Insights tab: time vs size / behavior / concentration.
  // All three read App.state.trades, so the filter bar (and its Advanced
  // filters) narrows them exactly like every other Reports tab.
  // =====================================================================
  const INS_SESSION_MIN = 390; // regular US session (6.5h) -- denominator for "time in market"
  const insSum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const insAvg = (arr, f) => (arr.length ? insSum(arr, f) / arr.length : null);
  const insUsd = (v) => (v == null || !Number.isFinite(v) ? "\u2014" : "$" + Math.round(v).toLocaleString());
  const insPct = (v, d = 1) => (v == null || !Number.isFinite(v) ? "\u2014" : v.toFixed(d) + "%");
  const insEmpty = (msg) => `<div class="empty-state small">${msg}</div>`;
  const insCls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "dim");
  const insDur = (m) => App.fmtDurationPrecise(m);
  const insPlural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  // A bold number inside a sentence. Clickable (opens the trades behind it)
  // whenever there are any; plain bold when there are none.
  function insLink(html, title, trades, sub) {
    const a = drillAttr(title, trades, { sub });
    return a ? `<b class="ins-link"${a}>${html}</b>` : `<b>${html}</b>`;
  }
  // Green/red wash for a heat-map cell, scaled against the biggest |value| on the grid.
  function insTint(v, maxAbs) {
    if (!maxAbs || !Number.isFinite(v) || v === 0) return "";
    const pct = Math.round(8 + 32 * Math.min(1, Math.abs(v) / maxAbs));
    return ` style="background:color-mix(in srgb, var(${v > 0 ? "--green" : "--red"}) ${pct}%, transparent)"`;
  }

  // One row per trade with the numbers all three blocks share. `notional`
  // is the money put into the position (entry price x shares) and `mins`
  // the time held; each is null -- never a made-up 0 -- when the trade
  // doesn't carry the data (no price / no share count / no usable times).
  function insRows(trades) {
    return trades.map((t) => {
      const px = Number(t.entry_price), sh = Number(t.shares), net = Number(t.pnl_after_comm);
      return {
        t,
        notional: t.entry_price != null && t.shares != null && px > 0 && sh > 0 ? px * sh : null,
        mins: App.durationMinutes(t),
        net: Number.isFinite(net) ? net : 0,
        // Before-commission P&L is null (not 0) when the trade doesn't carry it.
        gross: t.pnl_before_comm != null && Number.isFinite(Number(t.pnl_before_comm)) ? Number(t.pnl_before_comm) : null,
        comm: Number.isFinite(Number(t.commission)) ? Number(t.commission) : 0,
        shares: Number.isFinite(sh) ? sh : 0,
        win: Boolean(t.win),
        date: t.trade_date,
      };
    });
  }
  // Split rows into k roughly-equal-count buckets by `key` (ties stay together).
  function insQuantileBuckets(rows, key, k) {
    const vals = rows.map((r) => r[key]).sort((a, b) => a - b);
    const edges = [];
    for (let i = 1; i < k; i++) {
      const e = vals[Math.floor((vals.length * i) / k)];
      if (!edges.length || e > edges[edges.length - 1]) edges.push(e);
    }
    const buckets = Array.from({ length: edges.length + 1 }, () => ({ rows: [] }));
    rows.forEach((r) => {
      let i = 0;
      while (i < edges.length && r[key] >= edges[i]) i++;
      buckets[i].rows.push(r);
    });
    return buckets.filter((b) => b.rows.length).map((b) => {
      b.lo = b.rows.reduce((m, r) => Math.min(m, r[key]), Infinity);
      b.hi = b.rows.reduce((m, r) => Math.max(m, r[key]), -Infinity);
      return b;
    });
  }
  // Average minutes per trading day that you actually had *a* position open.
  // Overlapping trades are merged first so two positions held at the same
  // time count once, not twice.
  function insTimeInMarket(trades) {
    const toMin = (s) => {
      if (typeof s !== "string" || !s) return NaN;
      const [h, m, sec] = s.split(":").map(Number);
      return h * 60 + m + (sec || 0) / 60;
    };
    const byDay = new Map();
    trades.forEach((t) => {
      const a = toMin(t.entry_time), b = toMin(t.exit_time);
      if (!(b > a)) return;
      if (!byDay.has(t.trade_date)) byDay.set(t.trade_date, []);
      byDay.get(t.trade_date).push([a, b]);
    });
    if (!byDay.size) return null;
    let total = 0;
    byDay.forEach((iv) => {
      iv.sort((x, y) => x[0] - y[0]);
      let [cs, ce] = iv[0];
      iv.slice(1).forEach(([s, e]) => {
        if (s <= ce) ce = Math.max(ce, e);
        else { total += ce - cs; cs = s; ce = e; }
      });
      total += ce - cs;
    });
    return { days: byDay.size, avgPerDay: total / byDay.size };
  }

  // ---------------------------------------------------------------- Time vs size
  function renderInsightsTimeSize(rows, trades) {
    const el = document.getElementById("insights-timesize");
    if (!el) return;
    const both = rows.filter((r) => r.notional != null && r.mins != null);
    if (both.length < 5) {
      el.innerHTML = insEmpty("Needs at least 5 trades that have a price, a share count and a hold time.");
      return;
    }
    const wins = both.filter((r) => r.win), losses = both.filter((r) => !r.win);
    const capHours = (r) => (r.notional * r.mins) / 60; // dollars tied up x hours tied up
    // Total P&L / total capital-hours (not an average of per-trade ratios,
    // which explodes on 10-second trades).
    const perK = (arr) => { const c = insSum(arr, capHours); return c > 0 ? insSum(arr, (r) => r.net) / (c / 1000) : null; };
    const col = (arr) => ({
      n: arr.length,
      size: insAvg(arr, (r) => r.notional),
      hold: insAvg(arr, (r) => r.mins),
      ret: insAvg(arr, (r) => (r.net / r.notional) * 100),
      capK: insSum(arr, capHours) / 1000,
      perK: perK(arr),
    });
    const A = col(both), W = wins.length ? col(wins) : null, L = losses.length ? col(losses) : null;
    const insT = (arr) => arr.map((r) => r.t);
    const TS_SUB = "Trades with a price, share count and hold time";
    const cell = (c, f, arr, who, label) => `<td class="mono num">${c ? f(c) : "\u2014"}</td>`;
    const money = (v) => (v == null ? "\u2014" : `<span class="${insCls(v)}">${fmtMoney(v)}</span>`);
    const line = (label, f) => `<tr><td>${label}</td>${cell(A, f, both, "All trades", label)}${cell(W, f, wins, "Winners", label)}${cell(L, f, losses, "Losers", label)}</tr>`;

    // Plain-language reads -- only when both sides have enough trades to mean something.
    const notes = [];
    if (W && L && W.n >= 3 && L.n >= 3) {
      const hr = L.hold / W.hold;
      const hrL = (txt) => insLink(txt, "Losing trades \u00b7 hold time", insT(losses), `Losers are held about ${hr.toFixed(1)}\u00d7 as long as winners`);
      notes.push(hr >= 1.15 ? `You hold losers about ${hrL(`${hr.toFixed(1)}\u00d7 as long`)} as winners.`
        : hr <= 0.87 ? `You cut losers faster than winners (losers are held about ${hrL(`${hr.toFixed(1)}\u00d7`)} as long).`
        : `Winners and losers are held for about the same time.`);
      const sr = L.size / W.size;
      const srL = (txt) => insLink(txt, "Losing trades \u00b7 position size", insT(losses), "Compared with your winners' size");
      notes.push(sr >= 1.15 ? `Your losing trades are about ${srL(`${Math.round((sr - 1) * 100)}% bigger`)} than your winners.`
        : sr <= 0.87 ? `Your losing trades are about ${srL(`${Math.round((1 - sr) * 100)}% smaller`)} than your winners.`
        : `Winners and losers are about the same size.`);
    }
    const tim = insTimeInMarket(trades);
    const timedT = trades.filter((t) => insToMin(t.exit_time) > insToMin(t.entry_time));
    const timeLine = tim
      ? `On days you trade, you're in a position about ${insLink(insDur(tim.avgPerDay), "Time in market", timedT, "Trades with an entry and exit time")} (${insPct((tim.avgPerDay / INS_SESSION_MIN) * 100, 0)} of a 6.5-hour session), overlapping trades counted once.`
      : "";

    // Size buckets (equal trade counts) -> hold time / win rate / P&L / return per capital-hour.
    const k = both.length >= 20 ? 4 : both.length >= 9 ? 3 : 0;
    let sizeTable = "", grid = "";
    if (k) {
      const sizeB = insQuantileBuckets(both, "notional", k);
      const sizeName = (b, i) => `${i === 0 ? "Smallest" : i === sizeB.length - 1 ? "Largest" : "Mid"} \u00b7 ${insUsd(b.lo)}\u2013${insUsd(b.hi)}`;
      sizeTable = `<div class="table-scroll"><table class="report-table"><thead><tr>
        <th scope="col">Position size</th><th scope="col" class="num">Trades</th><th scope="col" class="num">Avg hold</th><th scope="col" class="num">Win rate</th>
        <th scope="col" class="num">Net P&amp;L</th><th scope="col" class="num">Avg return</th><th scope="col" class="num">$ per $1k-hour</th></tr></thead><tbody>
        ${sizeB.map((b, i) => {
          const wr = (b.rows.filter((r) => r.win).length / b.rows.length) * 100;
          const net = insSum(b.rows, (r) => r.net);
          return `<tr${drillAttr(sizeName(b, i), b.rows.map((r) => r.t), { row: true, sub: "By position size" })}><td>${sizeName(b, i)}</td><td class="mono num">${b.rows.length}</td>
            <td class="mono num">${insDur(insAvg(b.rows, (r) => r.mins))}</td>
            <td class="mono num ${wr >= 50 ? "up" : "down"}">${wr.toFixed(0)}%</td>
            <td class="mono num">${money(net)}</td>
            <td class="mono num ${insCls(insAvg(b.rows, (r) => r.net / r.notional))}">${insPct(insAvg(b.rows, (r) => (r.net / r.notional) * 100), 2)}</td>
            <td class="mono num">${money(perK(b.rows))}</td></tr>`;
        }).join("")}</tbody></table></div>`;

      // Size x hold-time grid: each cell = net P&L, with trade count and win rate under it.
      const holdB = insQuantileBuckets(both, "mins", k);
      const cells = sizeB.map((sb) => holdB.map((hb) => both.filter((r) => sb.rows.includes(r) && hb.rows.includes(r))));
      const maxAbs = cells.reduce((m, row) => row.reduce((mm, c) => Math.max(mm, Math.abs(insSum(c, (r) => r.net))), m), 0);
      grid = `<div class="table-scroll"><table class="report-table ins-heat"><thead><tr><th scope="col">Size \u2193 / Hold \u2192</th>
        ${holdB.map((hb) => `<th scope="col" class="num">${insDur(hb.lo)}\u2013${insDur(hb.hi)}</th>`).join("")}</tr></thead><tbody>
        ${sizeB.map((sb, i) => `<tr><td>${sizeName(sb, i)}</td>${cells[i].map((c, j) => {
          if (!c.length) return `<td class="cell dim">\u00b7</td>`;
          const net = insSum(c, (r) => r.net), wr = (c.filter((r) => r.win).length / c.length) * 100;
          const gridDrill = drillAttr(`${sizeName(sb, i)} \u00d7 hold ${insDur(holdB[j].lo)}\u2013${insDur(holdB[j].hi)}`, c.map((r) => r.t), { sub: "Size \u00d7 hold time" });
          return `<td class="cell"${insTint(net, maxAbs)}${gridDrill}><span class="${insCls(net)}">${fmtMoney(net)}</span><span class="sub">${c.length} \u00b7 ${wr.toFixed(0)}%</span></td>`;
        }).join("")}</tr>`).join("")}</tbody></table></div>
        <div class="ins-note">Each cell: net P&amp;L, then trade count \u00b7 win rate. Buckets hold roughly equal numbers of trades.</div>`;
    }

    el.innerHTML = `
      ${notes.length || timeLine ? `<p class="ins-lead">${notes.concat(timeLine ? [timeLine] : []).join(" ")}</p>` : ""}
      <div class="table-scroll"><table class="report-table"><thead><tr><th scope="col"></th>
        <th scope="col" class="num">All</th>
        <th scope="col" class="num">Winners</th>
        <th scope="col" class="num">Losers</th></tr></thead><tbody>
        ${line("Trades", (c) => c.n)}
        ${line("Avg position size", (c) => insUsd(c.size))}
        ${line("Avg hold time", (c) => insDur(c.hold))}
        ${line("Avg return on position", (c) => `<span class="${insCls(c.ret)}">${insPct(c.ret, 2)}</span>`)}
        ${line("Capital-hours ($1k\u00b7h)", (c) => c.capK.toFixed(1))}
        ${line("$ earned per $1k-hour", (c) => money(c.perK))}
      </tbody></table></div>
      ${k ? `<div class="ins-sub">By position size</div>${sizeTable}<div class="ins-sub">Size \u00d7 hold time</div>${grid}` : ""}
      <div class="ins-note">Position size = entry price \u00d7 shares. <b>$ per $1k-hour</b> = total P&amp;L \u00f7 (dollars tied up \u00d7 hours held, in thousands): how much each $1,000 earned for every hour it sat in a trade.
      ${both.length < rows.length ? ` ${insPlural(rows.length - both.length, "trade", "trades")} without a price, share count or hold time ${rows.length - both.length === 1 ? "is" : "are"} left out.` : ""}</div>`;
  }

  // ---------------------------------------------------------------- Behavior
  function renderInsightsBehavior(rows) {
    const el = document.getElementById("insights-behavior");
    if (!el) return;
    if (rows.length < 6) { el.innerHTML = insEmpty("Needs at least 6 trades."); return; }
    // Walk each day in entry order, tagging every trade with what came right before it.
    const byDay = new Map();
    rows.forEach((r) => { if (!byDay.has(r.date)) byDay.set(r.date, []); byDay.get(r.date).push(r); });
    const seq = [];
    byDay.forEach((list) => {
      list.sort((a, b) => String(a.t.entry_time || "").localeCompare(String(b.t.entry_time || "")));
      let lossRun = 0, prev = null, prevRow = null;
      list.forEach((r, i) => {
        // Minutes between the previous trade's exit and this trade's entry (negative = entered while still in it).
        const gapMin = prevRow ? insToMin(r.t.entry_time) - insToMin(prevRow.t.exit_time) : NaN;
        seq.push({ ...r, nth: i + 1, prev, lossRun, prevRow, gap: Number.isFinite(gapMin) ? gapMin : null });
        prev = r.win ? "win" : "loss";
        prevRow = r;
        lossRun = r.win ? 0 : lossRun + 1;
      });
    });
    const stat = (arr) => ({
      trades: arr.map((r) => r.t),
      n: arr.length,
      size: insAvg(arr.filter((r) => r.notional != null), (r) => r.notional),
      wr: arr.length ? (arr.filter((r) => r.win).length / arr.length) * 100 : null,
      avg: insAvg(arr, (r) => r.net),
      net: insSum(arr, (r) => r.net),
    });
    const groups = [
      ["First trade of the day", seq.filter((r) => r.nth === 1)],
      ["After a win", seq.filter((r) => r.prev === "win")],
      ["After a loss", seq.filter((r) => r.prev === "loss")],
      ["After 2+ losses in a row", seq.filter((r) => r.lossRun >= 2)],
    ].map(([label, arr]) => [label, stat(arr)]).filter(([, s]) => s.n);
    const after = Object.fromEntries(groups);
    const notes = [];
    const aw = after["After a win"], al = after["After a loss"];
    if (aw && al && aw.n >= 5 && al.n >= 5) {
      if (aw.size && al.size) {
        const r = al.size / aw.size;
        const szL = (txt) => insLink(txt, "Trades after a loss", al.trades, "Compared with trades after a win");
        notes.push(r >= 1.15 ? `You size up ${szL(`${Math.round((r - 1) * 100)}%`)} after a loss, compared with after a win \u2014 a common tilt pattern.`
          : r <= 0.87 ? `You size down ${szL(`${Math.round((1 - r) * 100)}%`)} after a loss, compared with after a win.`
          : `Your size stays about the same after a win or a loss.`);
      }
      const d = al.wr - aw.wr;
      if (Math.abs(d) >= 5) notes.push(`Your win rate is ${insLink(`${Math.abs(d).toFixed(0)} points ${d < 0 ? "lower" : "higher"}`, "Trades after a loss", al.trades, `Win rate ${al.wr.toFixed(0)}% after a loss vs ${aw.wr.toFixed(0)}% after a win`)} after a loss than after a win.`);
    }
    const behTable = `<div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">Situation</th><th scope="col" class="num">Trades</th><th scope="col" class="num">Avg size</th><th scope="col" class="num">Win rate</th><th scope="col" class="num">Avg P&amp;L</th><th scope="col" class="num">Net P&amp;L</th></tr></thead><tbody>
      ${groups.map(([label, s]) => `<tr${drillAttr(label, s.trades, { row: true, sub: "After a win or a loss" })}><td>${label}</td><td class="mono num">${s.n}</td><td class="mono num">${insUsd(s.size)}</td>
        <td class="mono num ${s.wr >= 50 ? "up" : "down"}">${s.wr.toFixed(0)}%</td>
        <td class="mono num ${insCls(s.avg)}">${fmtMoney(s.avg)}</td><td class="mono num ${insCls(s.net)}">${fmtMoney(s.net)}</td></tr>`).join("")}
      </tbody></table></div>`;

    // P&L by which trade of the day it was.
    const NTH = [[1, 1, "1st trade"], [2, 2, "2nd"], [3, 3, "3rd"], [4, 4, "4th"], [5, 5, "5th"], [6, 10, "6th\u201310th"], [11, Infinity, "11th +"]];
    const nthTable = `<div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">Trade of the day</th><th scope="col" class="num">Trades</th><th scope="col" class="num">Win rate</th><th scope="col" class="num">Avg P&amp;L</th><th scope="col" class="num">Net P&amp;L</th></tr></thead><tbody>
      ${NTH.map(([lo, hi, label]) => {
        const arr = seq.filter((r) => r.nth >= lo && r.nth <= hi);
        if (!arr.length) return "";
        const s = stat(arr);
        return `<tr${drillAttr(label, s.trades, { row: true, sub: "By trade number of the day" })}><td>${label}</td><td class="mono num">${s.n}</td><td class="mono num ${s.wr >= 50 ? "up" : "down"}">${s.wr.toFixed(0)}%</td>
          <td class="mono num ${insCls(s.avg)}">${fmtMoney(s.avg)}</td><td class="mono num ${insCls(s.net)}">${fmtMoney(s.net)}</td></tr>`;
      }).join("")}</tbody></table></div>`;

    // Days grouped by how many trades were taken (overtrading check).
    const DAYB = [[1, 3, "1\u20133 trades"], [4, 6, "4\u20136 trades"], [7, 10, "7\u201310 trades"], [11, 20, "11\u201320 trades"], [21, Infinity, "21+ trades"]];
    const dayList = Array.from(byDay.values()).map((list) => ({ n: list.length, net: insSum(list, (r) => r.net), trades: list.map((r) => r.t) }));
    const dayTable = `<div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">Trades taken that day</th><th scope="col" class="num">Days</th><th scope="col" class="num">Winning days</th><th scope="col" class="num">Avg day P&amp;L</th><th scope="col" class="num">Avg per trade</th></tr></thead><tbody>
      ${DAYB.map(([lo, hi, label]) => {
        const d = dayList.filter((x) => x.n >= lo && x.n <= hi);
        if (!d.length) return "";
        const w = (d.filter((x) => x.net > 0).length / d.length) * 100;
        const avgDay = insAvg(d, (x) => x.net), avgTr = insSum(d, (x) => x.net) / insSum(d, (x) => x.n);
        return `<tr${drillAttr(label, d.flatMap((x) => x.trades), { row: true, sub: "Every trade on days with this many trades" })}><td>${label}</td><td class="mono num">${d.length}</td><td class="mono num ${w >= 50 ? "up" : "down"}">${w.toFixed(0)}%</td>
          <td class="mono num ${insCls(avgDay)}">${fmtMoney(avgDay)}</td><td class="mono num ${insCls(avgTr)}">${fmtMoney(avgTr)}</td></tr>`;
      }).join("")}</tbody></table></div>`;

    el.innerHTML = `
      ${notes.length ? `<p class="ins-lead">${notes.join(" ")}</p>` : ""}
      <div class="ins-sub">What happens after a win or a loss</div>${behTable}
      <div class="ins-sub">How fast you re-enter <span class="ins-inline">· "fast" = within <input type="number" id="ins-fast-min" class="filter-input ins-rule-input" min="0" step="any" value="${insFastMin}" aria-label="Fast re-entry threshold in minutes" /> min</span></div>
      <div id="ins-reentry-body">${insReentryBody(seq)}</div>
      <div class="ins-sub">By trade number of the day</div>${nthTable}
      <div class="ins-sub">By number of trades taken in a day</div>${dayTable}
      <div class="ins-note">Trades are ordered by entry time within each day; "after" means the trade taken immediately before. Small samples (a handful of trades) can look dramatic by chance \u2014 weigh the Trades column.</div>`;
    const fastInput = document.getElementById("ins-fast-min");
    if (fastInput) fastInput.addEventListener("input", () => {
      const v = parseFloat(fastInput.value);
      if (!(v >= 0)) return;
      insFastMin = v;
      document.getElementById("ins-reentry-body").innerHTML = insReentryBody(seq);
    }, { signal: App.signal });
  }

  // ---------------------------------------------------------------- Concentration
  function renderInsightsConcentration(rows) {
    const el = document.getElementById("insights-concentration");
    if (!el) return;
    if (rows.length < 6) { el.innerHTML = insEmpty("Needs at least 6 trades."); return; }
    const total = insSum(rows, (r) => r.net);
    const tradesDesc = rows.map((r) => r.net).sort((a, b) => b - a);
    const dayMap = new Map();
    rows.forEach((r) => dayMap.set(r.date, (dayMap.get(r.date) || 0) + r.net));
    const daysDesc = Array.from(dayMap.values()).sort((a, b) => b - a);
    // Same orderings, but carrying the trades so each row can open them.
    const rowsDesc = rows.slice().sort((a, b) => b.net - a.net);
    const daysDescFull = Array.from(dayMap.entries()).map(([date, net]) => ({ net, trades: rows.filter((r) => r.date === date).map((r) => r.t) })).sort((a, b) => b.net - a.net);
    const tr = (arr) => arr.map((r) => r.t);
    const dy = (arr) => arr.flatMap((d) => d.trades);
    const top = (arr, n) => arr.slice(0, n);
    const bottom = (arr, n) => arr.slice(Math.max(0, arr.length - n));
    const tenPct = Math.max(1, Math.ceil(rows.length * 0.1));
    const defs = [
      ["Your best trade", top(tradesDesc, 1), "trade", tr(top(rowsDesc, 1))],
      ["Your best 3 trades", top(tradesDesc, 3), "trade", tr(top(rowsDesc, 3))],
      ["Your best 5 trades", top(tradesDesc, 5), "trade", tr(top(rowsDesc, 5))],
      [`Your best 10% of trades (${tenPct})`, top(tradesDesc, tenPct), "trade", tr(top(rowsDesc, tenPct))],
      ["Your best day", top(daysDesc, 1), "day", dy(top(daysDescFull, 1))],
      ["Your best 3 days", top(daysDesc, 3), "day", dy(top(daysDescFull, 3))],
      ["Your worst 3 trades", bottom(tradesDesc, 3), "trade", tr(bottom(rowsDesc, 3))],
      ["Your worst day", bottom(daysDesc, 1), "day", dy(bottom(daysDescFull, 1))],
    ];
    // What's left once a set of trades is taken out (by identity, so equal P&L can't confuse it).
    const without_ = (set) => { const gone = new Set(set); return tr(rows).filter((t) => !gone.has(t)); };
    const rowsHtml = defs.map(([label, removed, unit, set]) => {
      const rem = insSum(removed, (x) => x);
      const without = total - rem;
      return `<tr${drillAttr(label, set, { row: true, sub: "The trades being taken out" })}><td>${label}</td><td class="mono num ${insCls(rem)}">${fmtMoney(rem)}</td><td class="mono num ${insCls(without)}"><b>${fmtMoney(without)}</b></td></tr>`;
    }).join("");

    const best3 = insSum(top(tradesDesc, 3), (x) => x);
    const worst3 = insSum(bottom(tradesDesc, 3), (x) => x);
    const best3T = tr(top(rowsDesc, 3)), worst3T = tr(bottom(rowsDesc, 3));
    const allL = (v) => insLink(fmtMoney(v), "All trades", tr(rows), "Every trade in this view");
    let read;
    if (total > 0) {
      const leftL = insLink(fmtMoney(total - best3), "Everything except your best 3 trades", without_(best3T), "The trades that are left");
      read = total - best3 <= 0
        ? `Your profit leans on a few trades: without your best 3 you'd be at ${leftL} instead of ${allL(total)}.`
        : `Your profit is fairly spread out: even without your best 3 trades you'd still be at ${leftL}.`;
    } else {
      const leftL = insLink(fmtMoney(total - worst3), "Everything except your 3 worst trades", without_(worst3T), "The trades that are left");
      read = total - worst3 > 0
        ? `Your 3 worst trades account for the whole loss: without them you'd be at ${leftL} instead of ${allL(total)}.`
        : `The loss isn't just a few bad trades: even without your 3 worst you'd be at ${leftL}.`;
    }
    el.innerHTML = `
      <p class="ins-lead">${read}</p>
      <div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">If you took out\u2026</th><th scope="col" class="num">Their P&amp;L</th><th scope="col" class="num">Net P&amp;L without them</th></tr></thead><tbody>
        <tr><td><b>Everything (as is)</b></td><td class="mono num dim">\u2014</td><td class="mono num ${insCls(total)}"><b>${fmtMoney(total)}</b></td></tr>
        ${rowsHtml}</tbody></table></div>
      <div class="ins-note">Across ${insPlural(rows.length, "trade", "trades")} on ${insPlural(dayMap.size, "trading day", "trading days")}. Days are net P&amp;L per calendar day.</div>`;
  }

  // ---------------------------------------------------------------- Breakeven & costs
  const insUsd2 = (v) => (v == null || !Number.isFinite(v) ? "\u2014" : "$" + v.toFixed(2));
  const insPts = (v) => (v == null || !Number.isFinite(v) ? "\u2014" : (v >= 0 ? "+" : "\u2212") + Math.abs(v).toFixed(1) + " pts");
  // Break-even maths for a set of winning amounts and losing amounts (both
  // positive numbers). Break-even is where winRate x avgWin == lossRate x avgLoss,
  // i.e. winRate = avgLoss / (avgWin + avgLoss) = 1 / (1 + avgWin/avgLoss).
  function insBreakeven(winAmts, lossAmts) {
    const n = winAmts.length + lossAmts.length;
    if (!n) return null;
    const w = winAmts.length / n;
    const avgWin = winAmts.length ? winAmts.reduce((a, b) => a + b, 0) / winAmts.length : null;
    const avgLoss = lossAmts.length ? lossAmts.reduce((a, b) => a + b, 0) / lossAmts.length : null;
    const out = { n, w, winRate: w * 100, avgWin, avgLoss, be: null, cushion: null, needWin: null, maxLoss: null };
    if (avgWin != null && avgLoss != null && avgWin > 0 && avgLoss > 0) {
      out.be = (avgLoss / (avgWin + avgLoss)) * 100;
      out.cushion = out.winRate - out.be;
      // "Change only one thing" versions of break-even, at today's win rate:
      if (w > 0) out.needWin = ((1 - w) / w) * avgLoss;   // average win you'd need
      if (w < 1) out.maxLoss = (w / (1 - w)) * avgWin;    // biggest average loss you could afford
    }
    return out;
  }
  function insNetBreakeven(rows) {
    return insBreakeven(rows.filter((r) => r.win).map((r) => r.net), rows.filter((r) => !r.win).map((r) => Math.abs(r.net)));
  }
  function insGauge(b, allTrades) {
    const fill = Math.max(0, Math.min(100, b.winRate)), mark = Math.max(0, Math.min(100, b.be));
    const ok = b.winRate >= b.be;
    return `<div class="be-gauge">
      <div class="be-track"><div class="be-fill ${ok ? "ok" : "short"}" style="width:${fill.toFixed(1)}%"></div>
        <div class="be-mark" style="left:${mark.toFixed(1)}%"></div></div>
      <div class="be-legend"><span class="${ok ? "up" : "down"}">bar: your win rate</span><span>line: break-even point</span></div></div>`;
  }
  function insBreakevenTable(title, groups) {
    const list = groups.map(([label, arr]) => [label, arr, insNetBreakeven(arr)]).filter(([, arr, s]) => arr.length >= 5 && s && s.be != null);
    if (!list.length) return "";
    return `<div class="ins-sub">${title}</div><div class="table-scroll"><table class="report-table"><thead><tr>
      <th scope="col"></th><th scope="col" class="num">Trades</th><th scope="col" class="num">Win rate</th><th scope="col" class="num">Avg win</th><th scope="col" class="num">Avg loss</th>
      <th scope="col" class="num">Needed</th><th scope="col" class="num">Vs needed</th><th scope="col" class="num">Net P&amp;L</th></tr></thead><tbody>
      ${list.map(([label, arr, s]) => `<tr${drillAttr(unescHtml(label), arr.map((r) => r.t), { row: true, sub: title })}><td>${label}</td><td class="mono num">${s.n}</td><td class="mono num">${s.winRate.toFixed(0)}%</td>
        <td class="mono num">${insUsd2(s.avgWin)}</td><td class="mono num">${insUsd2(s.avgLoss)}</td><td class="mono num">${s.be.toFixed(0)}%</td>
        <td class="mono num ${insCls(s.cushion)}">${insPts(s.cushion)}</td>
        <td class="mono num ${insCls(insSum(arr, (r) => r.net))}">${fmtMoney(insSum(arr, (r) => r.net))}</td></tr>`).join("")}
      </tbody></table></div>`;
  }
  function renderInsightsBreakeven(rows) {
    const el = document.getElementById("insights-breakeven");
    if (!el) return;
    if (rows.length < 5) { el.innerHTML = insEmpty("Needs at least 5 trades."); return; }
    const B = insNetBreakeven(rows);
    if (!B || B.be == null) {
      el.innerHTML = insEmpty("Needs at least one winning and one losing trade to work out a break-even win rate.");
      return;
    }
    // "1.4 points" when the gap is small (whole numbers would hide it), "34 points" when it's big.
    const gapTxt = (v) => { const g = Math.abs(v); const t = g < 10 ? g.toFixed(1) : g.toFixed(0); return `${t} point${t === "1.0" || t === "1" ? "" : "s"}`; };
    const allT = rows.map((r) => r.t), winT = rows.filter((r) => r.win).map((r) => r.t), lossT = rows.filter((r) => !r.win).map((r) => r.t);
    const wrB = insLink(`${B.winRate.toFixed(0)}%`, "Your win rate", allT, "Every trade in this view");
    const awB = insLink(insUsd2(B.avgWin), "Winning trades", winT, "The trades behind your average win");
    const alB = insLink(insUsd2(B.avgLoss), "Losing trades", lossT, "The trades behind your average loss");
    const beB = insLink(`${B.be.toFixed(0)}%`, "Break-even win rate", allT, "Worked out from every trade in this view");
    const gapB = insLink(gapTxt(B.cushion), "Gap to break-even", allT, "Your win rate minus the break-even rate, over every trade");
    const lead = B.cushion < 0
      ? `You win ${wrB} of trades. With an average win of ${awB} and an average loss of ${alB}, you'd need ${beB} to break even \u2014 ${gapB} short.`
      : `You win ${wrB} of trades. With an average win of ${awB} and an average loss of ${alB}, you need ${beB} to break even \u2014 you're ${gapB} above it.`;

    // The three ways to close (or protect) the gap, changing one thing at a time.
    const lever = (label, set, now, needed, fmt, needsUp, inPoints) => {
      if (needed == null) return `<tr${drillAttr(unescHtml(label), set, { row: true, sub: "Break-even levers" })}><td>${label}</td><td class="mono num">${fmt(now)}</td><td class="mono num">\u2014</td><td class="mono num dim">\u2014</td></tr>`;
      const short = needsUp ? needed > now : needed < now;
      const pct = now ? Math.abs((needed - now) / now) * 100 : null;
      const sign = needed > now ? "+" : "\u2212";
      // Win rate is already a percentage, so its gap is in points; the dollar rows also get a % change.
      const gap = inPoints ? `${sign}${Math.abs(needed - now).toFixed(1)} pts`
        : `${sign}${fmt(Math.abs(needed - now))}${pct != null ? ` (${Math.round(pct)}%)` : ""}`;
      return `<tr${drillAttr(unescHtml(label), set, { row: true, sub: "Break-even levers" })}><td>${label}</td><td class="mono num">${fmt(now)}</td><td class="mono num">${fmt(needed)}</td>
        <td class="mono num ${short ? "down" : "up"}">${short ? "need " : "room "}${gap}</td></tr>`;
    };
    const pctFmt = (v) => v.toFixed(1) + "%";
    const levers = `<div class="ins-sub">What it would take to break even (change one thing, keep the others)</div>
      <div class="table-scroll"><table class="report-table"><thead><tr><th scope="col"></th><th scope="col" class="num">Now</th><th scope="col" class="num">Break-even</th><th scope="col" class="num">Gap</th></tr></thead><tbody>
        ${lever("Win rate", rows.map((r) => r.t), B.winRate, B.be, pctFmt, true, true)}
        ${lever("Average win", rows.filter((r) => r.win).map((r) => r.t), B.avgWin, B.needWin, insUsd2, true)}
        ${lever("Average loss (smaller is better)", rows.filter((r) => !r.win).map((r) => r.t), B.avgLoss, B.maxLoss, insUsd2, false)}
      </tbody></table></div>`;

    const bySetup = new Map();
    rows.forEach((r) => { const k = r.t.setup_type || ""; if (!bySetup.has(k)) bySetup.set(k, []); bySetup.get(k).push(r); });
    const setupTable = bySetup.size > 1
      ? insBreakevenTable("By setup", Array.from(bySetup.entries()).map(([k, arr]) => [k ? escapeHtml(prettifyTag(k)) : "Unlabeled", arr])) : "";
    const sideTable = insBreakevenTable("By side", ["long", "short"].map((s) => [s[0].toUpperCase() + s.slice(1), rows.filter((r) => String(r.t.side || "").toLowerCase() === s)]));

    // ---- Cost drag: the same numbers before vs after commissions.
    const withGross = rows.filter((r) => r.gross != null);
    const totalComm = insSum(rows, (r) => r.comm);
    let cost = "";
    if (withGross.length >= 5 && totalComm > 0) {
      const G = insBreakeven(withGross.filter((r) => r.gross > 0).map((r) => r.gross), withGross.filter((r) => r.gross <= 0).map((r) => Math.abs(r.gross)));
      const N = insNetBreakeven(withGross);
      const grossTotal = insSum(withGross, (r) => r.gross), netTotal = insSum(withGross, (r) => r.net), commTotal = insSum(withGross, (r) => r.comm);
      const shares = insSum(withGross.filter((r) => r.shares > 0), (r) => r.shares);
      const cps = (v) => (shares > 0 ? (v / shares) * 100 : null);
      const flips = withGross.filter((r) => r.gross > 0 && r.net <= 0);
      const grossWinners = withGross.filter((r) => r.gross > 0).length;
      const c2 = (v) => (v == null ? "\u2014" : `${v >= 0 ? "+" : "\u2212"}${Math.abs(v).toFixed(2)}\u00a2`);
      const line = (label, a, b, d, cls) => `<tr><td>${label}</td><td class="mono num">${a}</td><td class="mono num">${b}</td><td class="mono num ${cls || "dim"}">${d}</td></tr>`;
      const beRow = G && N && G.be != null && N.be != null
        ? line("Break-even win rate", G.be.toFixed(1) + "%", N.be.toFixed(1) + "%", insPts(N.be - G.be), N.be > G.be ? "down" : "up") : "";
      const wgT = withGross.map((r) => r.t);
      const grossL = insLink(fmtMoney(grossTotal), "P&L before commissions", wgT, "Trades with before-commission P&L");
      const netL = insLink(fmtMoney(netTotal), "P&L after commissions", wgT, "Trades with before-commission P&L");
      const commL = insLink(insUsd2(commTotal), "Commissions paid", wgT, "Trades with before-commission P&L");
      const read = grossTotal > 0 && netTotal <= 0
        ? `You're profitable <b>before</b> commissions (${grossL}), but commissions of ${commL} turn that into ${netL}.`
        : grossTotal <= 0
        ? `You're losing money even <b>before</b> commissions (${grossL}) \u2014 commissions (${commL}) make it worse rather than being the cause.`
        : `Commissions took ${commL} (${((commTotal / grossTotal) * 100).toFixed(0)}% of your gross profit of ${grossL}).`;
      cost = `<div class="ins-sub">Cost drag \u2014 before vs after commissions</div>
        <p class="ins-lead">${read}</p>
        <div class="table-scroll"><table class="report-table"><thead><tr><th scope="col"></th><th scope="col" class="num">Before commissions</th><th scope="col" class="num">After commissions</th><th scope="col" class="num">Change</th></tr></thead><tbody>
          ${line("Total P&amp;L", fmtMoney(grossTotal), fmtMoney(netTotal), fmtMoney(netTotal - grossTotal), "down")}
          ${G && N ? line("Win rate", G.winRate.toFixed(1) + "%", N.winRate.toFixed(1) + "%", insPts(N.winRate - G.winRate), N.winRate < G.winRate ? "down" : "dim") : ""}
          ${G && N ? line("Average win", insUsd2(G.avgWin), insUsd2(N.avgWin), G.avgWin != null && N.avgWin != null ? fmtMoney(N.avgWin - G.avgWin) : "\u2014") : ""}
          ${G && N ? line("Average loss", insUsd2(G.avgLoss), insUsd2(N.avgLoss), G.avgLoss != null && N.avgLoss != null ? fmtMoney(N.avgLoss - G.avgLoss) : "\u2014") : ""}
          ${beRow}
          ${shares > 0 ? line("P&amp;L per share", c2(cps(grossTotal)), c2(cps(netTotal)), c2(cps(netTotal - grossTotal)), "down") : ""}
        </tbody></table></div>
        <div class="ins-note"><b${drillAttr("Made money before commissions, lost after", flips.map((r) => r.t), { sub: "Commission flips" })}>${flips.length}</b> of your ${withGross.length} trades (${((flips.length / withGross.length) * 100).toFixed(0)}%) made money before commissions but lost after them${grossWinners ? ` \u2014 ${((flips.length / grossWinners) * 100).toFixed(0)}% of your gross winners` : ""}.
        Commissions average ${insLink(insUsd2(commTotal / withGross.length), "Commissions per trade", wgT, "Trades with before-commission P&L")} a trade${shares > 0 ? ` (${(cps(commTotal)).toFixed(2)}\u00a2 a share)` : ""}.</div>`;
    } else if (totalComm <= 0) {
      cost = `<div class="ins-note">No commissions are recorded on these trades, so there is no cost-drag comparison to show.</div>`;
    }

    el.innerHTML = `
      <p class="ins-lead">${lead}</p>${insGauge(B, allT)}${levers}${setupTable}${sideTable}${cost}
      <div class="ins-note">Break-even win rate = average loss \u00f7 (average win + average loss), using P&amp;L after commissions. It's the win rate at which winners and losers cancel out exactly. Groups with fewer than 5 trades are hidden \u2014 small samples swing wildly.</div>`;
  }

  // ---------------------------------------------------------------- Re-entry timing + rule simulator
  // "HH:MM:SS" -> minutes since midnight (NaN when missing/garbled).
  function insToMin(s) {
    if (typeof s !== "string" || !s) return NaN;
    const [h, m, sec] = s.split(":").map(Number);
    return h * 60 + m + (sec || 0) / 60;
  }
  let insFastMin = 5; // "fast re-entry" = opened within this many minutes of the previous trade closing

  // How quickly you go back in after a loss (vs after a win), and whether the fast ones do worse.
  function insReentryBody(seq) {
    const withGap = seq.filter((r) => r.prev && r.gap != null);
    if (withGap.length < 8) return insEmpty("Needs at least 8 trades that follow another trade on the same day, with entry and exit times recorded.");
    const BUCKETS = [
      ["While still in the last trade", (g) => g < 0],
      ["Under 1 min", (g) => g >= 0 && g < 1],
      ["1\u20135 min", (g) => g >= 1 && g < 5],
      ["5\u201315 min", (g) => g >= 5 && g < 15],
      ["15\u201330 min", (g) => g >= 15 && g < 30],
      ["30+ min", (g) => g >= 30],
    ];
    const st = (arr) => (arr.length ? { trades: arr.map((r) => r.t), n: arr.length, wr: (arr.filter((r) => r.win).length / arr.length) * 100, avg: insAvg(arr, (r) => r.net), net: insSum(arr, (r) => r.net) } : null);
    // All three numbers in a group open the same trades.
    const cell = (s, title) => {
      if (!s) return `<td class="mono num dim">0</td><td class="mono num dim">\u2014</td><td class="mono num dim">\u2014</td>`;
      const a = drillAttr(title, s.trades, { sub: "Re-entry timing" });
      return `<td class="mono num"${a}>${s.n}</td><td class="mono num ${s.wr >= 50 ? "up" : "down"}"${a}>${s.wr.toFixed(0)}%</td><td class="mono num ${insCls(s.avg)}"${a}>${fmtMoney(s.avg)}</td>`;
    };
    const rowsHtml = BUCKETS.map(([label, f]) => {
      const inBucket = withGap.filter((r) => f(r.gap));
      const L = st(inBucket.filter((r) => r.prev === "loss")), W = st(inBucket.filter((r) => r.prev === "win"));
      return L || W ? `<tr><td${drillAttr(label, inBucket.map((r) => r.t), { row: true, sub: "Re-entry timing \u00b7 after a win or a loss" })}>${label}</td>${cell(L, label + " \u00b7 after a loss")}${cell(W, label + " \u00b7 after a win")}</tr>` : "";
    }).join("");

    // Fast vs slow after a loss, using the adjustable threshold.
    const T = insFastMin;
    const lossRows = withGap.filter((r) => r.prev === "loss");
    const fast = lossRows.filter((r) => r.gap <= T), slow = lossRows.filter((r) => r.gap > T);
    const notes = [];
    const fs = st(fast), ss = st(slow);
    if (fs && ss && fs.n >= 8 && ss.n >= 8) {
      const d = fs.wr - ss.wr;
      const fL = (txt) => insLink(txt, `Opened within ${T} min of a loss`, fs.trades, "Re-entry timing");
      const sL = (txt) => insLink(txt, `Opened more than ${T} min after a loss`, ss.trades, "Re-entry timing");
      notes.push(`Trades opened within ${fL(`${T} min`)} of a loss win ${fL(`${fs.wr.toFixed(0)}%`)} (net ${fL(fmtMoney(fs.net))}, ${fs.n} trades) versus ${sL(`${ss.wr.toFixed(0)}%`)} when you wait longer (net ${sL(fmtMoney(ss.net))}, ${ss.n} trades)${Math.abs(d) >= 5 ? ` \u2014 ${Math.abs(d).toFixed(0)} points ${d < 0 ? "worse" : "better"} when you rush back in` : ""}.`);
    } else {
      notes.push(`Not enough trades on both sides of ${T} min after a loss to compare (need 8 each) \u2014 try a different threshold.`);
    }
    // Fast AND bigger than the trade just closed: the classic "make it back" signature.
    const bigger = fast.filter((r) => r.notional != null && r.prevRow && r.prevRow.notional != null && r.notional >= 1.25 * r.prevRow.notional);
    const bs = st(bigger);
    if (bs && bs.n >= 3) {
      const bL = (txt) => insLink(txt, `Fast and 25%+ bigger (within ${T} min of a loss)`, bs.trades, "The \"make it back\" pattern");
      notes.push(`Of the ${fast.length} trades opened within ${T} min of a loss, ${bL(String(bs.n))} were also at least 25% bigger than the trade before \u2014 they won ${bL(`${bs.wr.toFixed(0)}%`)} and netted ${bL(fmtMoney(bs.net))}.`);
    }
    return `<p class="ins-lead">${notes.join(" ")}</p>
      <div class="table-scroll"><table class="report-table"><thead>
        <tr><th scope="col" rowspan="2">Time since the last trade closed</th><th scope="col" class="num" colspan="3">After a loss</th><th scope="col" class="num" colspan="3">After a win</th></tr>
        <tr><th scope="col" class="num">Trades</th><th scope="col" class="num">Win rate</th><th scope="col" class="num">Avg P&amp;L</th><th scope="col" class="num">Trades</th><th scope="col" class="num">Win rate</th><th scope="col" class="num">Avg P&amp;L</th></tr>
      </thead><tbody>${rowsHtml}</tbody></table></div>
      <div class="ins-note">Measured from the previous trade's exit to this trade's entry, same day only. "While still in the last trade" means you entered before the previous one closed.</div>`;
  }

  // ---- Rule simulator: replay your own days with a rule applied, one rule at a time.
  const INS_RULES = [
    { key: "streak", label: "Stop for the day after", unit: "losses in a row", step: 1 },
    { key: "dailyLoss", label: "Stop for the day once down", unit: "dollars", step: "any" },
    { key: "maxTrades", label: "Stop after", unit: "trades in a day", step: 1 },
    { key: "cooldown", label: "Wait after every loss", unit: "minutes", step: "any" },
    { key: "profitLock", label: "Stop for the day once up", unit: "dollars", step: "any" },
  ];
  let insRuleParams = { streak: 2, dailyLoss: null, maxTrades: null, cooldown: 5, profitLock: null }; // null = default worked out from the data
  let insRuleDays = [], insRuleDefaults = {}, insRuleTotal = 0;

  function insSimulate(days, key, p) {
    const skipped = [];
    let daysAffected = 0;
    days.forEach((list) => {
      let run = 0, net = 0, taken = 0, stopped = false, blockedUntil = -Infinity, hit = false;
      list.forEach((r) => {
        if (stopped) { skipped.push(r); hit = true; return; }
        if (key === "cooldown") {
          const e = insToMin(r.t.entry_time);
          if (Number.isFinite(e) && e < blockedUntil) { skipped.push(r); hit = true; return; }
        }
        taken++; net += r.net; run = r.win ? 0 : run + 1;
        if (key === "cooldown" && !r.win) { const x = insToMin(r.t.exit_time); blockedUntil = Number.isFinite(x) ? x + p : -Infinity; }
        if (key === "streak" && run >= p) stopped = true;
        if (key === "dailyLoss" && net <= -p) stopped = true;
        if (key === "profitLock" && net >= p) stopped = true;
        if (key === "maxTrades" && taken >= p) stopped = true;
      });
      if (hit) daysAffected++;
    });
    return { skipped, daysAffected };
  }
  const insRuleValue = (key) => (insRuleParams[key] != null ? insRuleParams[key] : insRuleDefaults[key]);
  function insRuleOutcome(rule) {
    const p = insRuleValue(rule.key);
    const sim = insSimulate(insRuleDays, rule.key, p);
    const skippedNet = insSum(sim.skipped, (r) => r.net);
    const skippedSet = new Set(sim.skipped);
    return {
      rule, p, n: sim.skipped.length, days: sim.daysAffected, skipped: sim.skipped,
      kept: insRuleDays.flat().filter((r) => !skippedSet.has(r)),
      wr: sim.skipped.length ? (sim.skipped.filter((r) => r.win).length / sim.skipped.length) * 100 : null,
      pnl: insRuleTotal - skippedNet, change: -skippedNet,
    };
  }
  function insFillRuleRow(tr, o) {
    const set = (cls, html) => { const c = tr.querySelector("." + cls); if (c) c.innerHTML = html; };
    const ruleName = `${o.rule.label} ${o.rule.unit === "dollars" ? "$" + o.p : o.p + " " + o.rule.unit}`;
    const skipA = o.n ? drillAttr(`Skipped by rule: ${ruleName}`, o.skipped.map((r) => r.t), { sub: "The trades this rule would have kept you out of" }) : "";
    const keptA = "";
    set("r-n", o.n ? `<span${skipA}>${o.n}</span>` : "0");
    set("r-days", o.n ? `<span${skipA}>${o.days}</span>` : String(o.days));
    set("r-wr", o.wr == null ? "\u2014" : `<span class="${o.wr >= 50 ? "up" : "down"}"${skipA}>${o.wr.toFixed(0)}%</span>`);
    set("r-pnl", `<span class="${insCls(o.pnl)}"${keptA}>${fmtMoney(o.pnl)}</span>`);
    set("r-chg", o.n ? `<span class="${insCls(o.change)}"${skipA}><b>${fmtMoney(o.change)}</b></span>` : `<span class="dim">no effect</span>`);
  }
  function insRefreshRules() {
    const panel = document.getElementById("insights-rules");
    if (!panel) return;
    const outs = INS_RULES.map(insRuleOutcome);
    panel.querySelectorAll("tr[data-rule]").forEach((tr) => insFillRuleRow(tr, outs.find((o) => o.rule.key === tr.dataset.rule)));
    const affecting = outs.filter((o) => o.n > 0);
    const best = affecting.reduce((b, o) => (!b || o.change > b.change ? o : b), null);
    const lead = document.getElementById("ins-rules-lead");
    if (lead) lead.innerHTML = !affecting.length
      ? "None of these rules would have changed anything with the values below."
      : best.change > 0
        ? (() => {
          const bestSet = best.skipped.map((r) => r.t);
          const bestSub = "The trades this rule would have kept you out of";
          const bestName = `${best.rule.label} ${best.rule.unit === "dollars" ? "$" + best.p : best.p + " " + best.rule.unit}`;
          return `In hindsight, the rule that would have helped most is ${insLink(`${best.rule.label.toLowerCase()} ${best.rule.unit === "dollars" ? "$" + best.p : best.p + " " + best.rule.unit}`, `Skipped by rule: ${bestName}`, bestSet, bestSub)}: ${insLink(fmtMoney(best.change), `Skipped by rule: ${bestName}`, bestSet, bestSub)} better, by skipping ${best.n} ${best.n === 1 ? "trade" : "trades"} on ${best.days} ${best.days === 1 ? "day" : "days"}.`;
        })()
        : "None of these rules would have improved your P&amp;L \u2014 the trades they'd have skipped made about as much as they lost.";
  }
  function renderInsightsRules(rows) {
    const el = document.getElementById("insights-rules");
    if (!el) return;
    if (rows.length < 10) { el.innerHTML = insEmpty("Needs at least 10 trades."); return; }
    const byDay = new Map();
    rows.forEach((r) => { if (!byDay.has(r.date)) byDay.set(r.date, []); byDay.get(r.date).push(r); });
    insRuleDays = Array.from(byDay.values()).map((l) => l.slice().sort((a, b) => String(a.t.entry_time || "").localeCompare(String(b.t.entry_time || ""))));
    insRuleTotal = insSum(rows, (r) => r.net);
    // Starting values come from your own trade sizes (3x an average loss / win, a busy-day trade count), not from tuning against the results.
    const wins = rows.filter((r) => r.win), losses = rows.filter((r) => !r.win);
    const counts = insRuleDays.map((l) => l.length).sort((a, b) => a - b);
    insRuleDefaults = {
      dailyLoss: Math.max(1, Math.round(3 * (losses.length ? insAvg(losses, (r) => Math.abs(r.net)) : 1))),
      profitLock: Math.max(1, Math.round(3 * (wins.length ? insAvg(wins, (r) => r.net) : 1))),
      maxTrades: Math.max(3, counts[Math.floor(counts.length * 0.75)] || 3),
    };
    const rowsHtml = INS_RULES.map((rule) => `<tr data-rule="${rule.key}">
      <td>${rule.label}</td>
      <td><input type="number" class="filter-input ins-rule-input" data-rule="${rule.key}" min="0" step="${rule.step}" value="${insRuleValue(rule.key)}" aria-label="${rule.label} (${rule.unit})" /> <span class="dim">${rule.unit}</span></td>
      <td class="mono num r-n"></td><td class="mono num r-days"></td><td class="mono num r-wr"></td><td class="mono num r-pnl"></td><td class="mono num r-chg"></td></tr>`).join("");
    el.innerHTML = `
      <p class="ins-lead" id="ins-rules-lead"></p>
      <div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">Rule</th><th scope="col">Value</th><th scope="col" class="num">Trades skipped</th><th scope="col" class="num">Days affected</th><th scope="col" class="num">Skipped win rate</th><th scope="col" class="num">P&amp;L with rule</th><th scope="col" class="num">Change</th></tr></thead>
        <tbody>${rowsHtml}
        <tr class="dim"><td>Your actual results</td><td></td><td class="mono num">0</td><td class="mono num">0</td><td class="mono num">\u2014</td><td class="mono num"><span class="${insCls(insRuleTotal)}">${fmtMoney(insRuleTotal)}</span></td><td class="mono num">\u2014</td></tr></tbody></table></div>
      <div class="ins-note">Each rule is tested on its own against your real days, in the order you entered trades. It assumes the trades a rule would have skipped are simply not taken, and that the rest go exactly as they did \u2014 in reality you'd also trade differently after stopping, so treat this as a hint, not a forecast. Change the values to see how sensitive the result is: a rule that only helps at one exact number is probably fitting noise. The starting values are 3\u00d7 your average loss / win and a busy-day trade count, not tuned to your results.</div>`;
    insRefreshRules();
    if (!el.__rulesBound) {
      el.__rulesBound = true;
      el.addEventListener("input", (e) => {
        const inp = e.target.closest && e.target.closest("input.ins-rule-input");
        if (!inp) return;
        const v = parseFloat(inp.value);
        if (!(v >= 0)) return;
        insRuleParams[inp.dataset.rule] = v;
        insRefreshRules();
      }, { signal: App.signal });
    }
  }

  function renderInsights() {
    const trades = App.state.trades;
    const rows = insRows(trades);
    if (!rows.length) {
      ["insights-breakeven", "insights-timesize", "insights-behavior", "insights-rules", "insights-concentration"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = insEmpty("No data yet.");
      });
      return;
    }
    // Independent panels: one failing shouldn't blank the others.
    App.safeRender(() => renderInsightsBreakeven(rows), "renderInsightsBreakeven");
    App.safeRender(() => renderInsightsTimeSize(rows, trades), "renderInsightsTimeSize");
    App.safeRender(() => renderInsightsBehavior(rows), "renderInsightsBehavior");
    App.safeRender(() => renderInsightsRules(rows), "renderInsightsRules");
    App.safeRender(() => renderInsightsConcentration(rows), "renderInsightsConcentration");
  }

  App.tabs.reports.initReportFilters = initReportFilters;
  App.tabs.reports.applyReportFiltersAndRender = applyReportFiltersAndRender;
})();
