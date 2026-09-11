// edge-analysis.js — edge-analysis page logic (bucket breakdowns, regret
// analysis, drill-down detail fetches). Used to be an inline <script>
// block in edge-analysis.html; pulled out into its own file, same reason
// as calculator.js -- it was the other of the two remaining pages still
// doing this, and it's exactly where the leaking-chart bug (chart
// instances built inside repeated drill-down calls with no teardown)
// turned up, which is easier to spot and lint in a real .js file.
(function () {
  "use strict";

  const content = document.getElementById("edge-content");
  const REGRET_MAX = 100; // cap on how many detail files a bar-level run will fetch

  let allSorted = [];
  let regretResults = [];
  let rowSeq = 0;
  let explainSeq = 0;
  const summaryState = { totalTrades: 0, baseline: 0, flaggedSetups: 0, totalSetups: 0, sizingTellActive: null, regretCapture: null };
  let decayGroups = {};
  let decayRows = [];
  let decaySort = { key: "n", dir: -1 };

  window.fetchTradesIndex()
    .then((rows) => render(Array.isArray(rows) ? rows : []))
    .catch((err) => {
      content.innerHTML = `<div class="empty-state">Couldn't load your trades (${escapeHtml(String(err.message))}).</div>`;
    });

  // See app.js's identical helper for why this exists: renderDecay /
  // renderVolume / renderSizing each own a totally different section of
  // this page, so one throwing on some edge-case field shouldn't stop
  // the others from rendering or leave their "Loading…" placeholder
  // stuck forever.
  function safeRender(fn, label) {
    try { fn(); } catch (err) { console.error(`[edge-analysis] ${label} failed:`, err); }
  }
  function clearStrandedLoadingStates() {
    content.querySelectorAll(".loading-line").forEach((el) => {
      const container = el.parentElement || el;
      container.innerHTML = '<div class="empty-state small">Couldn\'t load this section — check the console for details.</div>';
    });
  }

  // ---------- shared helpers (same conventions as stats.html / journal.html) ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtMoney(v) {
    if (typeof v !== "number" || !isFinite(v)) return "—";
    const sign = v >= 0 ? "+" : "-";
    return sign + "$" + Math.abs(v).toFixed(2);
  }
  function avg(arr) {
    if (!arr.length) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }
  function pctWin(trades) {
    if (!trades.length) return 0;
    return Math.round((trades.filter((t) => t.win).length / trades.length) * 1000) / 10;
  }
  function groupBy(rows, keyFn) {
    const g = {};
    for (const r of rows) { const k = keyFn(r); (g[k] = g[k] || []).push(r); }
    return g;
  }
  // Rendered TRADE_LIST_PAGE_SIZE at a time with a "Load more" button --
  // see the identical comment in app.js -- rather than dumping every
  // trade behind a breakdown row into the DOM at once.
  const TRADE_LIST_PAGE_SIZE = 25;
  const tradeListState = new Map(); // uid -> { rows, shown }

  function tradeListItemHtml(r) {
    return `<li><a href="trade.html?id=${encodeURIComponent(r.id)}">${escapeHtml(r.symbol)} — ${escapeHtml(r.trade_date)} <span class="${r.win ? "up" : "down"}">${r.win ? "WIN" : "LOSS"}</span></a></li>`;
  }
  function tradeListMoreHtml(uid, remaining) {
    return `<li class="tag-trade-list-more"><button type="button" class="btn-load-more" data-load-more="${uid}">Load more (${remaining} left)</button></li>`;
  }
  function tradeListHtml(rowsList, uid) {
    const sorted = rowsList.slice().sort((a, b) => (b.trade_date || "").localeCompare(a.trade_date || ""));
    const shown = Math.min(TRADE_LIST_PAGE_SIZE, sorted.length);
    tradeListState.set(uid, { rows: sorted, shown });
    const items = sorted.slice(0, shown).map(tradeListItemHtml).join("");
    const more = shown < sorted.length ? tradeListMoreHtml(uid, sorted.length - shown) : "";
    return `<ul class="tag-trade-list" id="${uid}">${items}${more}</ul>`;
  }
  function bindTradeToggles(container) {
    container.querySelectorAll("[data-trade-toggle]").forEach((row) => {
      row.addEventListener("click", () => {
        const uid = row.getAttribute("data-trade-toggle");
        const list = document.getElementById(uid);
        if (!list) return;
        const nowOpen = list.classList.toggle("open");
        if (nowOpen) openUids.add(uid); else openUids.delete(uid);
        syncUrlState();
      });
    });
    container.querySelectorAll("[data-load-more]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const uid = btn.getAttribute("data-load-more");
        const state = tradeListState.get(uid);
        if (!state) return;
        const nextShown = Math.min(state.shown + TRADE_LIST_PAGE_SIZE, state.rows.length);
        const newItemsHtml = state.rows.slice(state.shown, nextShown).map(tradeListItemHtml).join("");
        state.shown = nextShown;
        const moreLi = btn.closest("li");
        moreLi.insertAdjacentHTML("beforebegin", newItemsHtml);
        if (state.shown < state.rows.length) {
          btn.textContent = `Load more (${state.rows.length - state.shown} left)`;
        } else {
          moreLi.remove();
        }
        syncUrlState();
      });
    });
  }

  // ---------- URL state (see NavState in nav.js) ----------
  // edge-trades-N uids come from a counter that resets to 0 each render
  // and is handed out in a fixed order (decay rows, then volume/float
  // rows, then sizing rows -- see the render() call order below), so
  // for the same trade data and the same decay-table sort they come out
  // identical from one page load to the next. That's what makes it safe
  // to persist which uids are open across a reload.
  const openUids = new Set();
  function syncUrlState() {
    const shownObj = {};
    openUids.forEach((uid) => {
      const state = tradeListState.get(uid);
      if (state && state.shown > TRADE_LIST_PAGE_SIZE) shownObj[uid] = state.shown;
    });
    const decaySel = document.getElementById("decay-setup-select");
    NavState.set({
      dsort: (decaySort.key !== "n" || decaySort.dir !== -1) ? `${decaySort.key}:${decaySort.dir}` : null,
      dsel: (decaySel && decaySel.value) || null,
      open: openUids.size ? JSON.stringify(Array.from(openUids)) : null,
      shown: Object.keys(shownObj).length ? JSON.stringify(shownObj) : null,
    });
  }
  // Re-opens whichever breakdown rows were expanded (and re-loads
  // however many rows had been paged into them). Called once at the end
  // of render(), after decay/volume/sizing have all populated
  // tradeListState for this page load -- and after decaySort has
  // already been restored (below), so the decay rows' uids land in the
  // same order they did last time.
  function restoreTradeListState() {
    let openArr = [];
    let shownObj = {};
    try { openArr = JSON.parse(NavState.get("open", "[]")) || []; } catch (e) { /* malformed/old URL, ignore */ }
    try { shownObj = JSON.parse(NavState.get("shown", "{}")) || {}; } catch (e) { /* malformed/old URL, ignore */ }
    openArr.forEach((uid) => {
      const list = document.getElementById(uid);
      const state = tradeListState.get(uid);
      if (!list || !state) return;
      list.classList.add("open");
      openUids.add(uid);
      const desired = shownObj[uid];
      if (desired && desired > state.shown) {
        const nextShown = Math.min(desired, state.rows.length);
        const newItemsHtml = state.rows.slice(state.shown, nextShown).map(tradeListItemHtml).join("");
        state.shown = nextShown;
        const moreLi = list.querySelector(".tag-trade-list-more");
        if (moreLi) {
          moreLi.insertAdjacentHTML("beforebegin", newItemsHtml);
          if (state.shown < state.rows.length) {
            const btn = moreLi.querySelector("[data-load-more]");
            if (btn) btn.textContent = `Load more (${state.rows.length - state.shown} left)`;
          } else {
            moreLi.remove();
          }
        }
      }
    });
  }
  function makeChart(el, height, extraOpts) {
    // Every caller (renderDecayChart, renderRegretTradeChart,
    // renderSizingChart) re-runs against the same container on ordinary
    // interaction -- switching the "setup" or "trade" dropdown re-renders
    // its chart every time. Each caller does el.innerHTML = "" first, but
    // that only clears the DOM; it doesn't dispose the previous
    // LightweightCharts instance or the window resize listener below, so
    // without this, every dropdown change orphaned another chart engine
    // (still running internally, invisible, forever) plus another resize
    // listener stacked on top of the last. Track both on the container
    // itself (innerHTML = "" doesn't touch JS properties on the node) and
    // tear down whatever was there before building the new one.
    if (el._chart) { try { el._chart.remove(); } catch (e) {} }
    if (el._chartResizeHandler) { window.removeEventListener("resize", el._chartResizeHandler); }
    const chart = LightweightCharts.createChart(el, Object.assign({
      width: el.clientWidth,
      height,
      layout: { background: { color: "transparent" }, textColor: "#8b8fa3" },
      grid: { vertLines: { color: "#1b1e26" }, horzLines: { color: "#1b1e26" } },
      rightPriceScale: { borderColor: "#262a34" },
      timeScale: { borderColor: "#262a34" },
    }, extraOpts || {}));
    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    window.addEventListener("resize", onResize);
    el._chart = chart;
    el._chartResizeHandler = onResize;
    return chart;
  }

  // Bars render at width:0 with their real target stashed in data-w, so
  // they can grow in instead of just appearing already-filled -- called
  // right after any bar-row markup is dropped into the DOM.
  function animateBarFills(root) {
    if (!root) return;
    const bars = root.querySelectorAll(".bar-fill[data-w]");
    if (!bars.length) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        bars.forEach((b) => { b.style.width = b.dataset.w + "%"; });
      });
    });
  }

  // ---------- explainer: short blurb + expandable deep-dive, one per section ----------
  function explainBlock(blurb, deepDiveHtml) {
    const uid = `edge-explain-${explainSeq++}`;
    return `
      <div class="edge-explain">
        <p class="edge-explain-blurb">${blurb}</p>
        <button type="button" class="edge-explain-toggle" data-explain-toggle="${uid}" aria-expanded="false">
          <span>How this works</span>
          <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </button>
        <div class="edge-explain-body" id="${uid}" hidden>${deepDiveHtml}</div>
      </div>`;
  }
  function bindExplainToggles(root) {
    (root || document).querySelectorAll("[data-explain-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const body = document.getElementById(btn.getAttribute("data-explain-toggle"));
        const wasOpen = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", String(!wasOpen));
        if (body) body.hidden = wasOpen;
      });
    });
  }
  function sectionIcon(pathsSvg) {
    return `<span class="edge-section-icon">${pathsSvg}</span>`;
  }
  const ICON_DECAY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"></path><path d="M15 7h6v6"></path></svg>`;
  const ICON_VOLUME = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="20" x2="4" y2="10"></line><line x1="10" y1="20" x2="10" y2="4"></line><line x1="16" y1="20" x2="16" y2="14"></line><line x1="22" y1="20" x2="22" y2="8"></line></svg>`;
  const ICON_REGRET = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15.5 14"></polyline></svg>`;
  const ICON_SIZING = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="12" width="4" height="9"></rect><rect x="10" y="7" width="4" height="14"></rect><rect x="17" y="3" width="4" height="18"></rect></svg>`;

  // ---------- edge-health summary strip ----------
  function statIcon(pathsSvg) { return `<svg class="label-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${pathsSvg}</svg>`; }
  function renderEdgeHealthSummary() {
    const el = document.getElementById("edge-health");
    if (!el) return;
    const flagPct = summaryState.totalSetups ? Math.round((summaryState.flaggedSetups / summaryState.totalSetups) * 100) : null;
    const sizingLabel = summaryState.sizingTellActive === null ? "—" : (summaryState.sizingTellActive ? "Active" : "Clean");
    const sizingCls = summaryState.sizingTellActive === true ? "down" : (summaryState.sizingTellActive === false ? "up" : "");
    const regretLabel = summaryState.regretCapture === null ? "Not run yet" : `${Math.round(summaryState.regretCapture * 100)}%`;
    const regretCls = summaryState.regretCapture === null ? "" : (summaryState.regretCapture >= 0.6 ? "up" : "down");
    el.innerHTML = `
      <div class="stat" title="Every published trade in data/trades.json">
        <div class="label-row"><span class="label">Trades Analyzed</span>${statIcon('<rect x="3" y="3" width="7" height="9" rx="1.5"></rect><rect x="14" y="3" width="7" height="5" rx="1.5"></rect><rect x="14" y="12" width="7" height="9" rx="1.5"></rect><rect x="3" y="16" width="7" height="5" rx="1.5"></rect>')}</div>
        <div class="value">${summaryState.totalTrades}</div>
        <div class="sub-value">${summaryState.baseline}% overall win rate</div>
      </div>
      <div class="stat" title="Setups whose win rate is fading or looks driven by a recent hot streak — see Edge Decay below">
        <div class="label-row"><span class="label">Setups Flagged</span>${statIcon('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>')}</div>
        <div class="value ${summaryState.flaggedSetups > 0 ? "down" : "up"}">${summaryState.flaggedSetups} / ${summaryState.totalSetups}</div>
        <div class="sub-value">${flagPct === null ? "—" : flagPct + "%"} fading or recency-driven</div>
      </div>
      <div class="stat" title="Whether you tend to size up right before a losing stretch — see Position Sizing below">
        <div class="label-row"><span class="label">Sizing Tell</span>${statIcon('<rect x="3" y="12" width="4" height="9"></rect><rect x="10" y="7" width="4" height="14"></rect><rect x="17" y="3" width="4" height="18"></rect>')}</div>
        <div class="value ${sizingCls}">${sizingLabel}</div>
        <div class="sub-value">sizing up before a bad stretch</div>
      </div>
      <div class="stat" title="How much of each trade's best available price you actually captured — run the Regret Curve below to fill this in">
        <div class="label-row"><span class="label">Best-Bar Capture</span>${statIcon('<circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15.5 14"></polyline>')}</div>
        <div class="value ${regretCls}">${regretLabel}</div>
        <div class="sub-value">avg. of best bar-close, when run</div>
      </div>
    `;
  }

  // ---------- sticky jump-nav with scrollspy ----------
  function initJumpnav() {
    const nav = document.getElementById("edge-jumpnav");
    if (!nav) return;
    const pills = Array.from(nav.querySelectorAll(".pill[data-section]"));
    pills.forEach((pill) => {
      pill.addEventListener("click", () => {
        const target = document.getElementById(pill.dataset.section);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    if (!("IntersectionObserver" in window)) return;
    const sections = pills.map((p) => document.getElementById(p.dataset.section)).filter(Boolean);
    const setActive = (id) => {
      pills.forEach((p) => p.classList.toggle("active", p.dataset.section === id));
    };
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) setActive(entry.target.id);
      });
    }, { rootMargin: "-30% 0px -60% 0px", threshold: 0 });
    sections.forEach((s) => io.observe(s));
  }

  // ---------- page shell ----------
  function render(rows) {
    if (!rows.length) {
      content.innerHTML = `<div class="empty-state">No trades published yet.</div>`;
      return;
    }
    allSorted = rows.slice().sort((a, b) => ((a.trade_date || "") + (a.entry_time || "")).localeCompare((b.trade_date || "") + (b.entry_time || "")));
    const baseline = pctWin(allSorted);

    // Restored once per boot from the URL (see NavState in nav.js), and
    // before renderDecay() runs below, so the decay table's row order
    // (and therefore the uids trade-list toggles get restored against
    // further down) matches whatever sort was active last time instead
    // of resetting to the n-desc default.
    const dsortParam = NavState.get("dsort");
    if (dsortParam) {
      const [dsortKey, dsortDir] = dsortParam.split(":");
      if (dsortKey && (dsortDir === "1" || dsortDir === "-1")) decaySort = { key: dsortKey, dir: Number(dsortDir) };
    }

    content.innerHTML = `
      <div class="edge-intro">
        <div class="edge-intro-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7 7-4 11L21 3 10 14l11 7-7-4"></path></svg></div>
        <div>
          <h2>Is your edge real, or did you get lucky?</h2>
          <p>Four skeptical checks against <span class="mono">data/trades.json</span> — built to try to break your stats, not flatter them: whether each setup's win rate is holding up or fading, whether a volume/float tag beats baseline by more than noise, how much money your exit timing is leaving on the table, and whether you size up right before your worst stretches. Each section below has a plain summary and a "How this works" toggle for the exact math.</p>
        </div>
      </div>

      <div class="stat-grid" id="edge-health" style="margin-bottom:18px;"></div>

      <div class="edge-jumpnav" id="edge-jumpnav">
        <span class="pill active" data-section="section-decay"><span class="dot"></span>Edge Decay</span>
        <span class="pill" data-section="section-volume"><span class="dot"></span>Volume &amp; Float</span>
        <span class="pill" data-section="section-regret"><span class="dot"></span>Regret Curve</span>
        <span class="pill" data-section="section-sizing"><span class="dot"></span>Position Sizing</span>
      </div>

      <div class="panel-box" id="section-decay" style="margin-bottom:16px;">
        <div class="edge-section-head">${sectionIcon(ICON_DECAY)}<span class="title">Setup Edge Decay</span></div>
        ${explainBlock(
          `Checks whether each setup's win rate is holding up as more trades come in — or whether it's fading, improving, or mostly a recent hot streak. Click a row to see the trades behind it.`,
          `<p>Every setup's trades are split, in date order, into an earlier half and a later half, and win rate is compared between them. Separately, the <b>last 3 trades</b> for that setup are compared against everything before them.</p>
           <p>A setup gets flagged as:</p>
           <ul>
             <li><b>too early — n&lt;10</b> — not enough trades yet to say anything reliable</li>
             <li><b>fading</b> — win rate dropped 20+ points from the first half to the second half</li>
             <li><b>improving</b> — win rate rose 20+ points from the first half to the second half</li>
             <li><b>recency-driven</b> — the last 3 trades are running 30+ points hotter than everything before them, so the win rate you're seeing may mostly be a hot streak, not the setup itself</li>
             <li><b>stable</b> — none of the above triggered</li>
           </ul>
           <p>The chart plots a rolling win rate as the selected setup's trades accumulate in order — a real edge should settle down as the sample grows, not keep swinging with every new trade.</p>`
        )}
        <div class="decay-head">
          <span class="sortable" data-sort="setup">Setup <span class="sort-arrow">▲</span></span>
          <span></span>
          <span class="sortable c-num" data-sort="overall">Win % <span class="sort-arrow">▲</span></span>
          <span class="c-half">1st → 2nd half</span>
          <span class="sortable c-num" data-sort="n">N <span class="sort-arrow">▲</span></span>
          <span></span>
        </div>
        <div id="decay-body"></div>
        <div class="filters" style="margin:18px 0 10px;"><select id="decay-setup-select"></select></div>
        <div id="decay-chart" style="height:220px;"></div>
        <p style="color:var(--text-faint); font-size:12px; margin-top:8px;">Rolling win rate as each setup's trades accumulate in order.</p>
      </div>

      <div class="panel-box" id="section-volume" style="margin-bottom:16px;">
        <div class="edge-section-head">${sectionIcon(ICON_VOLUME)}<span class="title">Volume &amp; Float Edge Check</span></div>
        ${explainBlock(
          `Tests whether relative volume and float tags actually predict wins, beyond your overall baseline win rate of <b>${baseline}%</b> — or whether they're just noise riding along with a setup that already works.`,
          `<p>Every tag (relative volume, float, and the combination of the two) is compared against your overall baseline win rate. A tag only means something if its win rate clears that baseline by a real margin — rows with under 5 trades are marked <code>n=X</code> so a coin-flip-sized sample doesn't get mistaken for a pattern.</p>
           <p>The <b>quintile</b> chart buckets every trade with a relative-volume reading into 5 equal-sized groups, lowest to highest, and shows each bucket's win rate. If Q5 (highest) doesn't clearly beat Q1 (lowest), relative volume by itself probably isn't doing the work.</p>`
        )}
        <div style="margin-bottom:16px;"><div class="group-label" style="font-size:11px; color:var(--text-faint); text-transform:uppercase; letter-spacing:0.05em; margin:0 0 6px;">Relative Volume Tag</div><div id="rvol-breakdown"></div></div>
        <div style="margin-bottom:16px;"><div class="group-label" style="font-size:11px; color:var(--text-faint); text-transform:uppercase; letter-spacing:0.05em; margin:0 0 6px;">Float Tag</div><div id="float-breakdown"></div></div>
        <div style="margin-bottom:16px;"><div class="group-label" style="font-size:11px; color:var(--text-faint); text-transform:uppercase; letter-spacing:0.05em; margin:0 0 6px;">Float × Relative Volume</div><div id="combo-breakdown"></div></div>
        <div>
          <div class="group-label" style="font-size:11px; color:var(--text-faint); text-transform:uppercase; letter-spacing:0.05em; margin:0 0 6px;">Relative Volume Quintiles (continuous)</div>
          <div id="rvol-quintiles"></div>
        </div>
      </div>

      <div class="panel-box" id="section-regret" style="margin-bottom:16px;">
        <div class="edge-section-head">${sectionIcon(ICON_REGRET)}<span class="title">Regret Curve — Exit Timing</span></div>
        ${explainBlock(
          `Replays the bar-by-bar price action after your entry and compares your actual exit to the best price that was available — the shape of your exit mistakes, not just a dollar total. Pulls each trade's detail file on demand (capped at the most recent ${REGRET_MAX} trades), so run it manually below.`,
          `<p>For each trade, this replays every price bar from your entry onward and finds the best bar-close price that was ever available, then compares it to where you actually exited. It's an approximation of what was achievable — it can only judge bar-close prices, not the full intrabar range.</p>
           <ul>
             <li><b>Capture %</b> — actual P&amp;L ÷ best available P&amp;L, capped between −100% and 200% so one outlier trade doesn't skew the average</li>
             <li><b>Gave Back Profit</b> — you exited after the best bar close had already passed, so some of that profit slipped away</li>
             <li><b>Left Early</b> — you exited before the best bar close arrived; you might have been able to hold longer</li>
             <li><b>Bar-Perfect Gap</b> — total dollars between your actual result and exiting every trade at its best bar close</li>
           </ul>`
        )}
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px; flex-wrap:wrap;">
          <button class="btn-confirm" id="regret-run-btn">Run bar-level exit analysis</button>
          <span id="regret-status" style="color:var(--text-faint); font-size:12px;"></span>
        </div>
        <div id="regret-progress" style="display:none; margin-bottom:14px;"><div class="progress-track"><div class="progress-fill" id="regret-progress-fill" style="width:0%;"></div></div></div>
        <div id="regret-summary"></div>
        <div id="regret-histogram"></div>
        <div class="edge-section-head" style="margin-top:22px;"><span class="title">Regret Curve for One Trade</span></div>
        <div class="filters" style="margin:8px 0 10px;"><select id="regret-trade-select"><option value="">Run the analysis above first…</option></select></div>
        <div id="regret-trade-chart" style="height:240px;"></div>
        <div id="regret-trade-note" style="color:var(--text-faint); font-size:12px; margin-top:8px;"></div>
      </div>

      <div class="panel-box" id="section-sizing" style="margin-bottom:16px;">
        <div class="edge-section-head">${sectionIcon(ICON_SIZING)}<span class="title">Position Sizing</span></div>
        ${explainBlock(
          `Buckets trades by position size to see if win rate holds at bigger size, and flags the classic tell of sizing up right before a losing stretch.`,
          `<p>Trades are sorted by share count and split into four equal-sized buckets, smallest to largest, so you can see whether your win rate holds up — or falls off — as you size up.</p>
           <p>Separately, a trade counts as a <b>size-up</b> if its share count is 1.5× or more above the trailing 5-trade average size at that point in your history. The two stats below compare the win rate on those size-up trades, and on the 3 trades immediately following one, against your overall baseline.</p>
           <p>The chart plots one bar per trade in chronological order — height is share size, color is win (green) or loss (red). A run of tall bars turning red is the pattern worth watching for.</p>`
        )}
        <div id="sizing-body" style="margin-bottom:18px;"></div>
        <div id="sizing-tell" style="margin-bottom:18px;"></div>
        <div id="sizing-chart" style="height:220px;"></div>
      </div>
    `;

    summaryState.totalTrades = allSorted.length;
    summaryState.baseline = baseline;

    safeRender(() => renderDecay(allSorted), "renderDecay");
    safeRender(() => renderVolume(allSorted, baseline), "renderVolume");
    safeRender(() => renderSizing(allSorted), "renderSizing");
    safeRender(renderEdgeHealthSummary, "renderEdgeHealthSummary");
    safeRender(initJumpnav, "initJumpnav");
    safeRender(() => bindExplainToggles(content), "bindExplainToggles");
    clearStrandedLoadingStates();
    const regretBtn = document.getElementById("regret-run-btn");
    if (regretBtn) regretBtn.addEventListener("click", runRegretAnalysis);
    restoreTradeListState();
  }

  // ================= 1. SETUP EDGE DECAY =================
  function renderDecay(sorted) {
    const groups = groupBy(sorted, (r) => r.setup_type || "unlabeled");
    decayGroups = groups;

    decayRows = Object.entries(groups).map(([setup, trades]) => {
      const n = trades.length;
      const overall = pctWin(trades);
      const half = Math.floor(n / 2);
      const firstRate = n >= 4 ? pctWin(trades.slice(0, half)) : null;
      const secondRate = n >= 4 ? pctWin(trades.slice(half)) : null;
      const last3 = trades.slice(-3);
      const priorRest = trades.slice(0, Math.max(0, n - 3));
      const last3Rate = last3.length === 3 ? pctWin(last3) : null;
      const restRate = priorRest.length ? pctWin(priorRest) : null;

      let flag = "stable", flagCls = "";
      if (n < 10) { flag = "too early — n<10"; flagCls = ""; }
      else if (last3Rate !== null && restRate !== null && (last3Rate - restRate) >= 30) { flag = "recency-driven"; flagCls = "loss"; }
      else if (firstRate !== null && secondRate !== null && (secondRate - firstRate) <= -20) { flag = "fading"; flagCls = "loss"; }
      else if (firstRate !== null && secondRate !== null && (secondRate - firstRate) >= 20) { flag = "improving"; flagCls = "win"; }

      return { setup, trades, n, overall, firstRate, secondRate, flag, flagCls };
    });

    summaryState.totalSetups = decayRows.length;
    summaryState.flaggedSetups = decayRows.filter((r) => r.flagCls === "loss").length;

    document.querySelectorAll(".decay-head .sortable").forEach((headEl) => {
      headEl.addEventListener("click", () => {
        const key = headEl.dataset.sort;
        if (decaySort.key === key) decaySort.dir *= -1;
        else decaySort = { key, dir: key === "setup" ? 1 : -1 };
        renderDecayRows();
        syncUrlState();
      });
    });
    renderDecayRows();

    const entries = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
    const sel = document.getElementById("decay-setup-select");
    sel.innerHTML = entries.map(([s]) => `<option value="${escapeHtml(s)}">${escapeHtml(s.replace(/_/g, " "))} (${groups[s].length}x)</option>`).join("");
    // Restored from the URL if the person had a different setup's trend
    // chart open last time; falls back to the biggest-sample setup
    // (entries[0], same as before) otherwise.
    const dselParam = NavState.get("dsel");
    const initialSetup = (dselParam && groups[dselParam]) ? dselParam : (entries.length ? entries[0][0] : null);
    if (initialSetup) sel.value = initialSetup;
    sel.onchange = () => { renderDecayChart(groups[sel.value] || []); syncUrlState(); };
    if (initialSetup) renderDecayChart(groups[initialSetup]);
  }

  function renderDecayRows() {
    const el = document.getElementById("decay-body");
    const { key, dir } = decaySort;
    const rows = decayRows.slice().sort((a, b) => {
      if (key === "setup") return dir * String(a.setup).localeCompare(String(b.setup));
      return dir * (a[key] - b[key]);
    });

    el.innerHTML = rows.map((r) => {
      const uid = `edge-trades-${rowSeq++}`;
      return `
        <div class="edge-row decay-row" data-trade-toggle="${uid}" data-clickable>
          <div class="c-label">${escapeHtml(r.setup.replace(/_/g, " "))}</div>
          <div class="c-bar bar-track"><div class="bar-fill" data-w="${r.overall}" style="width:0%; background:${r.overall >= 50 ? "var(--green)" : "var(--red)"};"></div></div>
          <div class="c-num">${r.overall}%</div>
          <div class="c-num c-half" style="color:var(--text-faint);">${r.firstRate === null ? "—" : r.firstRate + "%"} → ${r.secondRate === null ? "—" : r.secondRate + "%"}</div>
          <div class="c-num" style="color:var(--text-faint);">${r.n}x</div>
          <div class="c-flag"><span class="pill ${r.flagCls}">${r.flag}</span></div>
        </div>
        ${tradeListHtml(r.trades, uid)}
      `;
    }).join("") || `<div class="empty-state small">No setup_type data yet.</div>`;
    bindTradeToggles(el);
    animateBarFills(el);

    document.querySelectorAll(".decay-head .sortable").forEach((headEl) => {
      const active = headEl.dataset.sort === key;
      headEl.classList.toggle("sort-active", active);
      const arrow = headEl.querySelector(".sort-arrow");
      if (arrow) arrow.textContent = active ? (dir === 1 ? "▲" : "▼") : "▲";
    });
  }

  function renderDecayChart(trades) {
    const el = document.getElementById("decay-chart");
    el.innerHTML = "";
    if (trades.length < 2) { el.innerHTML = `<div class="empty-state small">Not enough trades yet to plot a trend.</div>`; return; }
    const chart = makeChart(el, 220, { timeScale: { borderColor: "#262a34", tickMarkFormatter: (t) => "#" + t }, localization: { timeFormatter: (t) => "Trade #" + t } });
    const series = chart.addLineSeries({ color: "#8b7cf6", lineWidth: 2 });
    let wins = 0;
    const data = trades.map((t, i) => {
      if (t.win) wins++;
      return { time: i + 1, value: Math.round((wins / (i + 1)) * 1000) / 10 };
    });
    series.setData(data);
    chart.timeScale().fitContent();
  }

  // ================= 2. VOLUME / FLOAT EDGE CHECK =================
  function renderVolume(sorted, baseline) {
    renderTagBreakdown("rvol-breakdown", groupBy(sorted.filter((r) => r.rvol_tag), (r) => r.rvol_tag), baseline);
    renderTagBreakdown("float-breakdown", groupBy(sorted.filter((r) => r.float_tag), (r) => r.float_tag), baseline);
    renderTagBreakdown("combo-breakdown", groupBy(sorted.filter((r) => r.rvol_tag && r.float_tag), (r) => `${r.float_tag} float · ${r.rvol_tag} rvol`), baseline);
    renderRvolQuintiles(sorted.filter((r) => typeof r.relative_volume === "number" && isFinite(r.relative_volume)));
  }

  function renderTagBreakdown(elId, groups, baseline) {
    const el = document.getElementById(elId);
    const entries = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
    if (!entries.length) { el.innerHTML = `<div class="empty-state small">No tagged trades yet.</div>`; return; }
    el.innerHTML = entries.map(([tag, trades]) => {
      const n = trades.length;
      const rate = pctWin(trades);
      const pnl = trades.reduce((s, r) => s + (r.pnl_after_comm || 0), 0);
      const delta = Math.round((rate - baseline) * 10) / 10;
      const uid = `edge-trades-${rowSeq++}`;
      return `<div class="edge-row tag-row" data-trade-toggle="${uid}" data-clickable>
        <div class="c-label" style="text-transform:none;">${escapeHtml(tag.replace(/_/g, " "))}${n < 5 ? ` <span class="pill" title="Fewer than 5 trades — treat as a rough signal, not a verdict.">n=${n}</span>` : ""}</div>
        <div class="c-bar bar-track"><div class="bar-fill" data-w="${rate}" style="width:0%; background:${rate >= 50 ? "var(--green)" : "var(--red)"};"></div></div>
        <div class="c-num">${rate}%</div>
        <div class="c-num c-delta" style="color:${delta >= 0 ? "var(--green)" : "var(--red)"};">${delta >= 0 ? "+" : ""}${delta}pt</div>
        <div class="c-num c-pnl" style="color:${pnl >= 0 ? "var(--green)" : "var(--red)"};">${fmtMoney(pnl)}</div>
        <div class="c-num" style="color:var(--text-faint);">${n}x</div>
      </div>
      ${tradeListHtml(trades, uid)}`;
    }).join("");
    bindTradeToggles(el);
    animateBarFills(el);
  }

  function renderRvolQuintiles(rows) {
    const el = document.getElementById("rvol-quintiles");
    if (rows.length < 10) { el.innerHTML = `<div class="empty-state small">Need at least 10 trades with relative_volume to bucket into quintiles (have ${rows.length}).</div>`; return; }
    const byRvol = rows.slice().sort((a, b) => a.relative_volume - b.relative_volume);
    const size = Math.ceil(byRvol.length / 5);
    const labels = ["Q1 — lowest rvol", "Q2", "Q3", "Q4", "Q5 — highest rvol"];
    let html = "";
    for (let i = 0; i < 5; i++) {
      const bucket = byRvol.slice(i * size, (i + 1) * size);
      if (!bucket.length) continue;
      const rate = pctWin(bucket);
      const lo = bucket[0].relative_volume.toFixed(2), hi = bucket[bucket.length - 1].relative_volume.toFixed(2);
      html += `<div class="edge-row quint-row">
        <div class="c-label">${labels[i]}</div>
        <div class="c-bar bar-track"><div class="bar-fill" data-w="${rate}" style="width:0%; background:${rate >= 50 ? "var(--green)" : "var(--red)"};"></div></div>
        <div class="c-num">${rate}%</div>
        <div class="c-num c-range" style="color:var(--text-faint);">${lo}x–${hi}x</div>
        <div class="c-num" style="color:var(--text-faint);">${bucket.length}x</div>
      </div>`;
    }
    el.innerHTML = html;
    animateBarFills(el);
  }

  // ================= 3. REGRET CURVE (bar-level) =================
  function computeRegretForTrade(row, detail) {
    const bars = detail && Array.isArray(detail.bars) ? detail.bars : null;
    if (!bars || !bars.length || typeof row.entry_price !== "number" || typeof row.exit_price !== "number") return null;
    const entryKey = `${row.trade_date}T${row.entry_time}`;
    const exitKey = `${row.trade_date}T${row.exit_time}`;
    let entryIdx = bars.findIndex((b) => b.t >= entryKey);
    if (entryIdx === -1) entryIdx = 0;
    let exitIdx = bars.findIndex((b) => b.t >= exitKey);
    if (exitIdx === -1) exitIdx = bars.length - 1;
    const sign = row.side === "short" ? -1 : 1;
    const path = [];
    let bestIdx = entryIdx, bestPnl = -Infinity;
    for (let i = entryIdx; i < bars.length; i++) {
      if (typeof bars[i].c !== "number") continue;
      const pnl = (bars[i].c - row.entry_price) * sign;
      path.push({ i, t: bars[i].t, pnl });
      if (pnl > bestPnl) { bestPnl = pnl; bestIdx = i; }
    }
    if (!path.length || bestPnl === -Infinity) return null;
    const actualPnl = (row.exit_price - row.entry_price) * sign;
    const gaveBackBars = exitIdx - bestIdx; // >0 held past the best bar close, <0 exited before reaching it
    const capture = bestPnl > 0 ? actualPnl / bestPnl : null;
    return { path, entryIdx, exitIdx, bestIdx, bestPnl, actualPnl, gaveBackBars, capture };
  }

  async function runRegretAnalysis() {
    const btn = document.getElementById("regret-run-btn");
    const status = document.getElementById("regret-status");
    const progWrap = document.getElementById("regret-progress");
    const progFill = document.getElementById("regret-progress-fill");
    btn.disabled = true;
    progWrap.style.display = "block";
    progFill.style.width = "0%";

    const candidates = allSorted.slice()
      .sort((a, b) => ((b.trade_date || "") + (b.entry_time || "")).localeCompare((a.trade_date || "") + (a.entry_time || "")))
      .slice(0, REGRET_MAX);

    regretResults = [];
    let done = 0;
    let idx = 0;
    const CONCURRENCY = 6;
    async function worker() {
      while (idx < candidates.length) {
        const row = candidates[idx++];
        try {
          const detail = await window.fetchTradeDetail(row.id);
          if (detail) {
            const computed = computeRegretForTrade(row, detail);
            if (computed) regretResults.push({ row, computed });
          }
        } catch (e) { /* skip this trade, keep going */ }
        done++;
        progFill.style.width = Math.round((done / candidates.length) * 100) + "%";
        status.textContent = `Loaded ${done} / ${candidates.length}`;
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));

    progWrap.style.display = "none";
    btn.disabled = false;
    btn.textContent = "Re-run bar-level exit analysis";
    status.textContent = `${regretResults.length} of ${candidates.length} checked trades had usable bar data.`;

    renderRegretSummary();
    renderRegretTradeSelect();
  }

  function renderRegretSummary() {
    const summaryEl = document.getElementById("regret-summary");
    const histEl = document.getElementById("regret-histogram");
    if (!regretResults.length) {
      summaryEl.innerHTML = `<div class="empty-state small">No usable bar data in the trades checked.</div>`;
      histEl.innerHTML = "";
      summaryState.regretCapture = null;
      renderEdgeHealthSummary();
      return;
    }
    const withCapture = regretResults.filter((r) => r.computed.capture !== null);
    const avgCapture = withCapture.length ? avg(withCapture.map((r) => Math.max(-1, Math.min(2, r.computed.capture)))) : null;
    const gaveBack = withCapture.filter((r) => r.computed.gaveBackBars > 0).length;
    const exitedEarly = withCapture.filter((r) => r.computed.gaveBackBars < 0).length;
    const moneyLeft = withCapture.reduce((s, r) => s + Math.max(0, r.computed.bestPnl - r.computed.actualPnl) * (r.row.shares || 0), 0);

    summaryState.regretCapture = avgCapture;
    renderEdgeHealthSummary();

    summaryEl.innerHTML = `
      <div class="stat-grid" style="margin-bottom:16px;">
        <div class="stat">
          <div class="label-row"><span class="label">Avg. Capture of Best Bar</span></div>
          <div class="value ${avgCapture !== null && avgCapture >= 0.6 ? "up" : "down"}">${avgCapture === null ? "—" : Math.round(avgCapture * 100) + "%"}</div>
          <div class="sub-value">${withCapture.length} trades that were ever favorable</div>
        </div>
        <div class="stat">
          <div class="label-row"><span class="label">Gave Back Profit</span></div>
          <div class="value down">${withCapture.length ? Math.round((gaveBack / withCapture.length) * 100) : 0}%</div>
          <div class="sub-value">exited after the best bar-close had passed</div>
        </div>
        <div class="stat">
          <div class="label-row"><span class="label">Left Early</span></div>
          <div class="value">${withCapture.length ? Math.round((exitedEarly / withCapture.length) * 100) : 0}%</div>
          <div class="sub-value">exited before the best bar-close arrived</div>
        </div>
        <div class="stat">
          <div class="label-row"><span class="label">Bar-Perfect Gap</span></div>
          <div class="value down">${fmtMoney(-moneyLeft)}</div>
          <div class="sub-value">vs. exiting at each trade's best bar close</div>
        </div>
      </div>
    `;

    const buckets = [
      { label: "Gave it all back (< 0%)", test: (c) => c < 0 },
      { label: "0–50% captured", test: (c) => c >= 0 && c < 0.5 },
      { label: "50–90% captured", test: (c) => c >= 0.5 && c < 0.9 },
      { label: "90–110% (near bar-perfect)", test: (c) => c >= 0.9 && c < 1.1 },
      { label: "> 110% (fill beat every bar close)", test: (c) => c >= 1.1 },
    ];
    const total = withCapture.length;
    histEl.innerHTML = total ? `<div class="edge-section-head" style="margin-top:6px;"><span class="title">Exit Efficiency Distribution</span></div>` +
      buckets.map((b) => {
        const rows = withCapture.filter((r) => b.test(r.computed.capture));
        const pct = total ? Math.round((rows.length / total) * 1000) / 10 : 0;
        return `<div class="edge-row" style="grid-template-columns: 240px minmax(60px,1fr) 50px 40px;">
          <div class="c-label" style="text-transform:none;">${b.label}</div>
          <div class="c-bar bar-track"><div class="bar-fill" data-w="${pct}" style="width:0%; background:var(--blue);"></div></div>
          <div class="c-num">${pct}%</div>
          <div class="c-num" style="color:var(--text-faint);">${rows.length}x</div>
        </div>`;
      }).join("") : "";
    animateBarFills(histEl);
  }

  function renderRegretTradeSelect() {
    const sel = document.getElementById("regret-trade-select");
    const sortedResults = regretResults.slice().sort((a, b) => (b.row.trade_date || "").localeCompare(a.row.trade_date || ""));
    if (!sortedResults.length) {
      sel.innerHTML = `<option value="">No trades available</option>`;
      document.getElementById("regret-trade-chart").innerHTML = "";
      document.getElementById("regret-trade-note").textContent = "";
      return;
    }
    sel.innerHTML = sortedResults.map((r) => `<option value="${escapeHtml(r.row.id)}">${escapeHtml(r.row.symbol)} — ${escapeHtml(r.row.trade_date)} (${r.row.win ? "WIN" : "LOSS"})</option>`).join("");
    sel.onchange = () => {
      const found = regretResults.find((r) => r.row.id === sel.value);
      if (found) renderRegretTradeChart(found);
    };
    sel.value = sortedResults[0].row.id;
    renderRegretTradeChart(sortedResults[0]);
  }

  function renderRegretTradeChart(entry) {
    const el = document.getElementById("regret-trade-chart");
    el.innerHTML = "";
    const { row, computed } = entry;
    const chart = makeChart(el, 240);
    const series = chart.addLineSeries({ color: "#5b93f0", lineWidth: 2 });
    const shares = row.shares || 1;
    const toTime = (t) => Math.floor(new Date(String(t).replace(" ", "T") + "Z").getTime() / 1000);
    const data = computed.path.map((p) => ({ time: toTime(p.t), value: Math.round(p.pnl * shares * 100) / 100 }));
    series.setData(data);

    const markers = [];
    const bestPoint = computed.path.find((p) => p.i === computed.bestIdx);
    if (bestPoint) markers.push({ time: toTime(bestPoint.t), position: "aboveBar", color: "#e8a94c", shape: "circle", text: "Best bar" });
    const exitPoint = computed.path.find((p) => p.i >= computed.exitIdx) || computed.path[computed.path.length - 1];
    if (exitPoint) markers.push({ time: toTime(exitPoint.t), position: "belowBar", color: row.win ? "#2fd08a" : "#f2555a", shape: "arrowDown", text: "Actual exit" });
    markers.sort((a, b) => a.time - b.time);
    series.setMarkers(markers);
    chart.timeScale().fitContent();

    const capPct = computed.capture === null ? "never favorable on a bar close" : `${Math.round(computed.capture * 100)}% of the best bar-close captured`;
    document.getElementById("regret-trade-note").innerHTML =
      `Best possible (bar-close) P&amp;L: <b>${fmtMoney(computed.bestPnl * shares)}</b> · Actual: <b>${fmtMoney(computed.actualPnl * shares)}</b> · ${capPct}. ` +
      `<a href="trade.html?id=${encodeURIComponent(row.id)}" target="_blank">Open trade →</a>`;
  }

  // ================= 4. POSITION SIZING =================
  function renderSizing(sorted) {
    const bySize = sorted.filter((r) => typeof r.shares === "number" && r.shares > 0);
    const bodyEl = document.getElementById("sizing-body");
    const tellEl = document.getElementById("sizing-tell");
    if (bySize.length < 8) {
      bodyEl.innerHTML = `<div class="empty-state small">Need more trades with share counts to bucket by size (have ${bySize.length}).</div>`;
      tellEl.innerHTML = "";
      document.getElementById("sizing-chart").innerHTML = "";
      summaryState.sizingTellActive = null;
      renderEdgeHealthSummary();
      return;
    }

    const byShares = bySize.slice().sort((a, b) => a.shares - b.shares);
    const q = Math.ceil(byShares.length / 4);
    const labels = ["Smallest 25%", "2nd quartile", "3rd quartile", "Largest 25%"];
    let html = "";
    for (let i = 0; i < 4; i++) {
      const bucket = byShares.slice(i * q, (i + 1) * q);
      if (!bucket.length) continue;
      const rate = pctWin(bucket);
      const pnl = bucket.reduce((s, r) => s + (r.pnl_after_comm || 0), 0);
      const lo = Math.min(...bucket.map((r) => r.shares)), hi = Math.max(...bucket.map((r) => r.shares));
      html += `<div class="edge-row size-row">
        <div class="c-label">${labels[i]}</div>
        <div class="c-bar bar-track"><div class="bar-fill" data-w="${rate}" style="width:0%; background:${rate >= 50 ? "var(--green)" : "var(--red)"};"></div></div>
        <div class="c-num">${rate}%</div>
        <div class="c-num c-range" style="color:var(--text-faint);">${lo}–${hi} sh</div>
        <div class="c-num c-pnl" style="color:${pnl >= 0 ? "var(--green)" : "var(--red)"};">${fmtMoney(pnl)}</div>
        <div class="c-num" style="color:var(--text-faint);">${bucket.length}x</div>
      </div>`;
    }
    bodyEl.innerHTML = html;
    animateBarFills(bodyEl);

    // "size-up tell": trades sized 1.5x+ the trailing 5-trade average share count,
    // and the win rate of whatever immediately follows one.
    const chrono = bySize; // already in chronological order (sorted upstream)
    const baseline = pctWin(chrono);
    const sizeUpTrades = [];
    const followSet = new Set();
    for (let i = 5; i < chrono.length; i++) {
      const trailing = avg(chrono.slice(i - 5, i).map((r) => r.shares));
      if (trailing > 0 && chrono[i].shares > trailing * 1.5) {
        sizeUpTrades.push(chrono[i]);
        chrono.slice(i + 1, i + 4).forEach((r) => followSet.add(r));
      }
    }
    const followTrades = Array.from(followSet);
    const sizeUpRate = sizeUpTrades.length ? pctWin(sizeUpTrades) : null;
    const followRate = followTrades.length ? pctWin(followTrades) : null;

    // Same "meaningfully worse, not just noise" margin used for the decay
    // flags elsewhere on this page -- inconclusive (null) until there's
    // at least a handful of size-up follow-through trades to judge from.
    summaryState.sizingTellActive = followTrades.length < 3 ? null : (followRate <= baseline - 15);
    renderEdgeHealthSummary();

    tellEl.innerHTML = `
      <div class="stat-grid" style="margin-bottom:0;">
        <div class="stat">
          <div class="label-row"><span class="label">Win Rate — Size-Up Trades</span></div>
          <div class="value ${sizeUpRate === null ? "" : (sizeUpRate >= baseline ? "up" : "down")}">${sizeUpRate === null ? "—" : sizeUpRate + "%"}</div>
          <div class="sub-value">${sizeUpTrades.length} trades sized 1.5×+ the trailing 5-trade avg, vs ${baseline}% baseline</div>
        </div>
        <div class="stat">
          <div class="label-row"><span class="label">Win Rate — Next 3 After a Size-Up</span></div>
          <div class="value ${followRate === null ? "" : (followRate >= baseline ? "up" : "down")}">${followRate === null ? "—" : followRate + "%"}</div>
          <div class="sub-value">${followTrades.length} trades immediately following a size-up</div>
        </div>
      </div>
    `;

    renderSizingChart(chrono);
  }

  function renderSizingChart(chrono) {
    const el = document.getElementById("sizing-chart");
    el.innerHTML = "";
    const chart = makeChart(el, 220, { timeScale: { borderColor: "#262a34", tickMarkFormatter: (t) => "#" + t }, localization: { timeFormatter: (t) => "Trade #" + t } });
    const series = chart.addHistogramSeries({ priceFormat: { type: "volume" } });
    series.setData(chrono.map((r, i) => ({ time: i + 1, value: r.shares, color: r.win ? "rgba(47,208,138,0.75)" : "rgba(242,85,90,0.75)" })));
    chart.timeScale().fitContent();
  }

})();
