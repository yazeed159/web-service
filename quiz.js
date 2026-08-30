(function () {
  "use strict";

  // ==================================================================
  // Chart-reading quiz built entirely from data/trades.json +
  // data/trades/<id>.json — the same files journal.html/trade.html
  // already read. No backend, no chart_service.py call: every bar,
  // indicator, and lesson used here was already published for that
  // trade, so the quiz just crops what's shown and asks about it
  // before letting you see the rest.
  // ==================================================================

  const HISTORY_KEY = "quiz:history";
  const HISTORY_MAX = 50;

  const els = {
    setupScreen: document.getElementById("quiz-setup-screen"),
    playScreen: document.getElementById("quiz-play-screen"),
    summaryScreen: document.getElementById("quiz-summary-screen"),
    setupSelect: document.getElementById("qf-setup"),
    resultSelect: document.getElementById("qf-result"),
    countRow: document.getElementById("qf-count-row"),
    blindCheck: document.getElementById("qf-blind"),
    tickModeRow: document.getElementById("qf-tickmode-row"),
    tickModeHint: document.getElementById("qf-tickmode-hint"),
    candidateCount: document.getElementById("qf-candidate-count"),
    startBtn: document.getElementById("qf-start-btn"),
    historyBox: document.getElementById("quiz-history-box"),
    focusBox: document.getElementById("quiz-focus-box"),
    progressLabel: document.getElementById("qp-progress-label"),
    progressFill: document.getElementById("qp-progress-fill"),
    scoreChip: document.getElementById("qp-score-chip"),
    streak: document.getElementById("qp-streak"),
    quitBtn: document.getElementById("qp-quit-btn"),
    card: document.getElementById("quiz-card"),
    scoreWrap: document.getElementById("qs-score-wrap"),
    breakdown: document.getElementById("qs-breakdown"),
    review: document.getElementById("qs-review"),
    againBtn: document.getElementById("qs-again-btn"),
    reviewMissedBtn: document.getElementById("qs-review-missed-btn"),
    backToSetupBtn: document.getElementById("qs-setup-btn"),
  };

  const state = {
    index: [],
    detailCache: {},
    queue: [],
    qIndex: 0,
    blind: true,
    tickMode: "sim", // "sim" (synthesized, offline) or "real" (live prints from chart_service.py)
    results: [],
    streak: 0,
    lastFilters: null,
    current: null, // the in-progress question's working state
  };

  // ---------------------------------------------------------------
  // small shared helpers (same conventions as trade.js)
  // ---------------------------------------------------------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function toUnix(t) {
    return Math.floor(new Date(String(t).replace(" ", "T") + "").getTime() / 1000);
  }
  function fmtPrice(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return "—";
    const n = Number(v);
    return n.toFixed(Math.abs(n) < 5 ? 4 : 2);
  }
  function fmtSignedPerShare(v) {
    if (!Number.isFinite(v)) return "—";
    const sign = v >= 0 ? "+" : "-";
    return sign + "$" + fmtPrice(Math.abs(v));
  }
  function pnlPerShare(entry, exit, side) {
    return side === "short" ? entry - exit : exit - entry;
  }
  // Bars are start-labeled minute candles; a floor-match (last bar whose
  // start time is <= the target time) finds the candle a given moment
  // actually falls inside — same rule trade.js uses for its markers.
  function barIndexAt(bars, unixTime) {
    let bestIdx = 0;
    for (let i = 0; i < bars.length; i++) {
      if (toUnix(bars[i].t) <= unixTime) bestIdx = i;
      else break;
    }
    return bestIdx;
  }
  // Baseline share count the size presets scale off of — not tied to what
  // was actually traded (that stays hidden until reveal), just a round
  // reference point so "size up / size down" means something concrete.
  const SIZE_BASELINE = 100;
  const SIZE_PRESETS = [
    { shares: 50, label: "Small", sub: "50 sh · low conviction" },
    { shares: SIZE_BASELINE, label: "Standard", sub: "100 sh" },
    { shares: 200, label: "Large", sub: "200 sh · high conviction" },
  ];
  const STOP_PRESETS = [
    { pct: 0.5, label: "Tight", sub: "0.5%" },
    { pct: 1, label: "Standard", sub: "1%" },
    { pct: 2, label: "Wide", sub: "2%" },
  ];

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------------------------------------------------------------
  // second-by-second replay — Polygon only gives us 1-min bars, so
  // there's no real tick feed to draw on. Instead we synthesize a
  // plausible intra-bar path: a deterministic (seeded, so a given
  // bar always replays the same way) walk from the previous close
  // through the bar's open, its high/low (order randomized per bar,
  // since either order is consistent with the same OHLC print), and
  // its close, with small random jitter layered on top so it doesn't
  // look like a robotic straight-line ramp. It's clearly labeled as
  // simulated in the UI — this is a practice aid, not real ticks.
  // Used for the checkpoint/exit stage only — the entry stage keeps
  // its forming-candle + live countdown badge look.
  // ---------------------------------------------------------------
  function seededRng(seedStr) {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) {
      h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return (h >>> 0) / 4294967296;
    };
  }
  const REPLAY_SECONDS = 30; // sub-ticks synthesized per 1-min bar
  // Real elapsed milliseconds represented by one synthesized sub-tick --
  // 30 sub-ticks span a real 60-second bar, so each one is worth 2 real
  // seconds. Playback paces itself against this (divided by the active
  // speed multiplier) instead of a fixed, arbitrarily-fast interval, so
  // "1x" genuinely means real time.
  const TICK_REAL_MS = 1000 * 60 / REPLAY_SECONDS; // 2000ms/tick at 1x
  const SPEED_STEPS = [1, 2, 4, 8];
  const ENTRY_LEADIN_SECONDS = 18; // ~10-20s of tape before the fill, per request
  state.replaySpeed = 1;

  function genSecondTicks(bar, prevClose, seed) {
    const n = REPLAY_SECONDS;
    const rng = seededRng(seed);
    const o = bar.o, h = bar.h, l = bar.l, c = bar.c;
    const start = Number.isFinite(prevClose) ? prevClose : o;
    const highFirst = rng() < 0.5;
    const waypoints = [
      { t: 0, p: start },
      { t: Math.round(n * 0.1), p: o },
      { t: Math.round(n * 0.42), p: highFirst ? h : l },
      { t: Math.round(n * 0.74), p: highFirst ? l : h },
      { t: n - 1, p: c },
    ];
    const range = Math.max(h - l, 0.0001);
    const jitterAmp = range * 0.07;
    const ticks = [];
    for (let s = 0; s < n; s++) {
      let a = waypoints[0], b = waypoints[waypoints.length - 1];
      for (let i = 0; i < waypoints.length - 1; i++) {
        if (s >= waypoints[i].t && s <= waypoints[i + 1].t) { a = waypoints[i]; b = waypoints[i + 1]; break; }
      }
      const span = Math.max(1, b.t - a.t);
      const frac = (s - a.t) / span;
      let price = a.p + (b.p - a.p) * frac;
      price += (rng() - 0.5) * 2 * jitterAmp;
      price = Math.min(h, Math.max(l, price));
      ticks.push(price);
    }
    ticks[n - 1] = c; // always land exactly on the bar's real close
    return ticks;
  }

  // ---------------------------------------------------------------
  // Real tick playback (opt-in, "Real ticks (from server)" on the setup
  // screen) — pulls actual trade prints for a bar's time window from
  // chart_service.py instead of synthesizing them. This calls a new
  // POST /tick-data route (added to chart_service.py alongside
  // /generate-chart and the /backtest/* routes — see README) rather than
  // anything Polygon's minute-bar aggregates give us directly.
  //
  // Request:  { symbol, start: <ISO>, end: <ISO> }  (start inclusive, end exclusive)
  // Response: { ticks: [ { t: <ISO or epoch ms>, p: <price> }, ... ] }
  //
  // Never rejects — any failure (no CHART_SERVICE_URL set, unreachable,
  // timeout, empty window) resolves to null so callers fall back to the
  // simulated path without extra error handling.
  // ---------------------------------------------------------------
  const CHART_SERVICE_FETCH_HEADERS = {
    "Content-Type": "application/json",
    // Same free-tier-ngrok workaround backtester.js/chat.js use.
    "ngrok-skip-browser-warning": "true",
  };
  function chartServiceBase() {
    const base = (window.CHART_SERVICE_URL || "").replace(/\/+$/, "");
    if (!base || base.includes("YOUR-NGROK-SUBDOMAIN")) return "";
    return base;
  }
  function fetchRealTicks(symbol, startUnix, endUnix) {
    const base = chartServiceBase();
    if (!base || !(endUnix > startUnix)) return Promise.resolve(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    return fetch(`${base}/tick-data`, {
      method: "POST",
      headers: CHART_SERVICE_FETCH_HEADERS,
      signal: controller.signal,
      body: JSON.stringify({
        symbol,
        start: new Date(startUnix * 1000).toISOString(),
        end: new Date(endUnix * 1000).toISOString(),
      }),
    })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((data) => {
        const raw = data && Array.isArray(data.ticks) ? data.ticks : null;
        if (!raw || !raw.length) return null;
        const cleaned = raw
          .map((t) => ({
            time: Math.floor((typeof t.t === "number" ? (t.t > 2e12 ? t.t / 1e6 : t.t) : new Date(t.t).getTime()) / 1000),
            price: Number(t.p),
          }))
          .filter((t) => Number.isFinite(t.time) && Number.isFinite(t.price) && t.price > 0)
          .sort((a, b) => a.time - b.time);
        return cleaned.length >= 2 ? cleaned : null;
      })
      .catch(() => null)
      .finally(() => clearTimeout(timeout));
  }

  // Ticks per real-time second, used to convert a seconds-count into a
  // count of our 2-real-second-apart synthesized sub-ticks.
  const TICKS_PER_SEC = REPLAY_SECONDS / 60;

  // Lead-in ticks for the entry decision — a ~10-20s runway of tape
  // (ENTRY_LEADIN_SECONDS) ending exactly at the fill, pulling from the
  // tail of the prior bar if the fill happens too early in its own bar
  // to supply the full runway on its own. Never goes past the fill
  // instant, so real mode never leaks anything past the moment you're
  // deciding at (and sim mode is pinned to the real fill for the same
  // reason). Ticks from the prior (already-closed) bar are marked
  // `paint:false` since that candle is already shown closed on the
  // chart — only the price readout should move during that stretch.
  function getEntryLeadInTicks(trade, bars, entryIdx, entryUnix, leadInSeconds) {
    const entryBar = bars[entryIdx];
    const barStart = toUnix(entryBar.t);
    const secondsIntoBar = Math.max(0, entryUnix - barStart);
    function simTicks() {
      const prevClose = entryIdx > 0 ? bars[entryIdx - 1].c : entryBar.o;
      const fullCur = genSecondTicks(entryBar, prevClose, `${trade.id}:entrylead`);
      const cutIdx = Math.max(1, Math.round(secondsIntoBar * TICKS_PER_SEC));
      const curSlice = fullCur.slice(0, cutIdx);
      curSlice[curSlice.length - 1] = trade.entry_price;
      let out = curSlice.map((p) => ({ price: p, barIdx: entryIdx, paint: true, delayMs: TICK_REAL_MS }));
      const wanted = Math.max(1, Math.round(leadInSeconds * TICKS_PER_SEC));
      const shortBy = wanted - curSlice.length;
      if (shortBy > 0 && entryIdx > 0) {
        const prevBar = bars[entryIdx - 1];
        const prevPrevClose = entryIdx > 1 ? bars[entryIdx - 2].c : prevBar.o;
        const fullPrev = genSecondTicks(prevBar, prevPrevClose, `${trade.id}:entrylead`);
        const tail = fullPrev.slice(Math.max(0, fullPrev.length - shortBy));
        out = tail.map((p) => ({ price: p, barIdx: entryIdx - 1, paint: false, delayMs: TICK_REAL_MS })).concat(out);
      }
      return out;
    }
    if (state.tickMode !== "real") return Promise.resolve({ ticks: simTicks(), real: false, fellBack: false });
    const start = entryUnix - leadInSeconds;
    return fetchRealTicks(trade.symbol, start, entryUnix).then((real) => {
      if (!real) return { ticks: simTicks(), real: false, fellBack: true };
      const out = [];
      for (let k = 0; k < real.length; k++) {
        const t = real[k];
        const paint = t.time >= barStart;
        const nextTime = k + 1 < real.length ? real[k + 1].time : entryUnix;
        const delayMs = Math.max(30, Math.min(4000, (nextTime - t.time) * 1000));
        out.push({ price: t.price, barIdx: paint ? entryIdx : entryIdx - 1, paint, delayMs });
      }
      if (out.length) out[out.length - 1].price = trade.entry_price;
      return { ticks: out, real: true, fellBack: false };
    });
  }

  // Continuous post-entry ticks — picks up exactly where the entry lead-in
  // left off (same seed for the entry bar's own path, so there's no visual
  // jump at the fill instant) and keeps streaming, bar after bar, all the
  // way to the real exit bar. This is the "keep ticking until you decide
  // to exit" stream; the caller checks each price against the stop live.
  function buildPostEntrySimTicks(trade, bars, entryIdx, entryUnix, exitIdx) {
    const entryBar = bars[entryIdx];
    const barStart = toUnix(entryBar.t);
    const secondsIntoBar = Math.max(0, entryUnix - barStart);
    const cutIdx = Math.max(1, Math.round(secondsIntoBar * TICKS_PER_SEC));
    const prevClose = entryIdx > 0 ? bars[entryIdx - 1].c : entryBar.o;
    const fullEntryTicks = genSecondTicks(entryBar, prevClose, `${trade.id}:entrylead`);
    const out = fullEntryTicks.slice(cutIdx).map((p) => ({ price: p, barIdx: entryIdx, paint: true, delayMs: TICK_REAL_MS }));
    for (let idx = entryIdx + 1; idx <= exitIdx; idx++) {
      const bar = bars[idx];
      const pc = bars[idx - 1].c;
      const prices = genSecondTicks(bar, pc, `${trade.id}:live:${bar.t}`);
      prices.forEach((p) => out.push({ price: p, barIdx: idx, paint: true, delayMs: TICK_REAL_MS }));
    }
    return out;
  }
  // /tick-data (chart_service.py) rejects windows over 5 minutes, and a
  // full entry->exit trade can easily run longer than that -- so this
  // fetches one bar (<=60s) at a time in parallel and stitches the
  // results together, rather than asking for the whole span in one call.
  // If any bar's fetch comes back empty, the whole stream falls back to
  // simulated (kept simple and consistent, rather than splicing real and
  // simulated segments together mid-stream).
  function getPostEntryLiveTicks(trade, bars, entryIdx, entryUnix, exitIdx) {
    const simTicks = () => buildPostEntrySimTicks(trade, bars, entryIdx, entryUnix, exitIdx);
    if (state.tickMode !== "real") return Promise.resolve({ ticks: simTicks(), real: false, fellBack: false });
    const entryBarEnd = toUnix(bars[entryIdx].t) + BAR_SECONDS;
    const fetches = [fetchRealTicks(trade.symbol, entryUnix, entryBarEnd).then((r) => ({ r, barIdx: entryIdx }))];
    for (let idx = entryIdx + 1; idx <= exitIdx; idx++) {
      const bStart = toUnix(bars[idx].t);
      fetches.push(fetchRealTicks(trade.symbol, bStart, bStart + BAR_SECONDS).then((r) => ({ r, barIdx: idx })));
    }
    return Promise.all(fetches).then((segments) => {
      if (segments.some((s) => !s.r)) return { ticks: simTicks(), real: false, fellBack: true };
      const out = [];
      segments.forEach((seg, si) => {
        const nextSeg = segments[si + 1];
        seg.r.forEach((t, k) => {
          const isLast = k === seg.r.length - 1;
          const nextTime = !isLast ? seg.r[k + 1].time
            : (nextSeg && nextSeg.r.length ? nextSeg.r[0].time : t.time + 1);
          const delayMs = Math.max(30, Math.min(4000, (nextTime - t.time) * 1000));
          out.push({ price: t.price, barIdx: seg.barIdx, paint: true, delayMs });
        });
      });
      return { ticks: out, real: true, fellBack: false };
    });
  }

  // Auto-plays through `ticks`, one per `tickMs`, updating a live price
  // readout. `actions` is a list of {id, label, kbd, cls} buttons that are
  // clickable at any point during playback; clicking one locks in the
  // current second and price and stops playback. If nobody clicks before
  // the ticks run out, `defaultActionId` fires automatically on the last
  // second. Returns { stop } to let a caller tear it down early (e.g. the
  // quiz question changes underneath it).
  // `ticks` here is an array of { price, delayMs, barIdx, paint } — see
  // the builders above. delayMs is the real-world gap (pre-speed-scaling)
  // before the *next* tick prints, so playback tracks actual elapsed time
  // instead of a fixed, arbitrarily-fast cadence. A speed control (1x/2x/
  // 4x/8x) is rendered alongside and rescales that gap live, without
  // restarting playback. Multi-bar streams (barIdx changes mid-stream)
  // grow a forming candle for the current bar and, the moment the stream
  // moves past it, finalize it to its real full OHLC (safe, since that
  // bar has already fully happened by then) before starting the next.
  function runLiveReplay(container, ticks, opts) {
    opts = opts || {};
    const unitLabel = opts.unitLabel || "tick";
    const tag = opts.tag || "simulated seconds";
    const tagCls = opts.tagCls ? ` ${opts.tagCls}` : "";
    const actions = opts.actions || [];
    container.innerHTML = `
      <div class="quiz-replay-panel">
        <div class="quiz-replay-top">
          <span class="quiz-replay-price"></span>
          <span class="quiz-replay-tag${tagCls}">${escapeHtml(tag)}</span>
        </div>
        ${opts.fallbackNote ? `<div class="quiz-replay-fallback">${escapeHtml(opts.fallbackNote)}</div>` : ""}
        <div class="quiz-replay-track"><div class="quiz-replay-bar" id="qz-replay-fill"></div></div>
        <div class="quiz-replay-row" id="qz-replay-actions"></div>
        <div class="quiz-replay-foot">
          <span class="quiz-replay-sec" id="qz-replay-sec"></span>
          ${opts.allowSpeed !== false ? `<span class="quiz-speed-row" id="qz-speed-row"></span>` : ""}
        </div>
      </div>
    `;
    const priceEl = container.querySelector(".quiz-replay-price");
    const fillEl = container.querySelector("#qz-replay-fill");
    const secEl = container.querySelector("#qz-replay-sec");
    const actionsEl = container.querySelector("#qz-replay-actions");
    const speedRow = container.querySelector("#qz-speed-row");

    actions.forEach((a) => {
      const btn = document.createElement("button");
      btn.id = `qz-${a.id}`;
      btn.className = `quiz-answer-btn ${a.cls || ""}`;
      btn.innerHTML = `${escapeHtml(a.label)}${a.kbd ? ` <span class="kbd">${escapeHtml(a.kbd)}</span>` : ""}`;
      btn.addEventListener("click", () => finish(a.id));
      actionsEl.appendChild(btn);
    });
    if (speedRow) {
      SPEED_STEPS.forEach((s) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = `quiz-speed-btn${state.replaySpeed === s ? " active" : ""}`;
        b.textContent = `${s}\u00d7`;
        b.addEventListener("click", () => {
          state.replaySpeed = s;
          speedRow.querySelectorAll(".quiz-speed-btn").forEach((x) => x.classList.remove("active"));
          b.classList.add("active");
        });
        speedRow.appendChild(b);
      });
    }

    const liveChart = opts.chartHandle || null;
    const barLookup = opts.barLookup || null;
    let formingBarIdx = null, formingBarObj = null, runningHigh = null, runningLow = null;
    function startForming(barIdx) {
      formingBarObj = barLookup ? barLookup(barIdx) : null;
      formingBarIdx = barIdx;
      runningHigh = formingBarObj ? formingBarObj.o : null;
      runningLow = formingBarObj ? formingBarObj.o : null;
    }
    function finalizeForming() {
      if (!liveChart || formingBarIdx == null || !formingBarObj) return;
      liveChart.series.update({
        time: toUnix(formingBarObj.t), open: formingBarObj.o, high: formingBarObj.h, low: formingBarObj.l, close: formingBarObj.c,
      });
      if (liveChart.volSeries) {
        liveChart.volSeries.update({
          time: toUnix(formingBarObj.t), value: formingBarObj.v || 0,
          color: formingBarObj.c >= formingBarObj.o ? "rgba(47,208,138,0.4)" : "rgba(242,85,90,0.4)",
        });
      }
    }
    function paintTick(tick) {
      if (!liveChart || !tick.paint || tick.barIdx == null) return;
      if (formingBarIdx !== tick.barIdx) { finalizeForming(); startForming(tick.barIdx); }
      if (!formingBarObj) return;
      if (tick.price > runningHigh) runningHigh = tick.price;
      if (tick.price < runningLow) runningLow = tick.price;
      liveChart.series.update({
        time: toUnix(formingBarObj.t), open: formingBarObj.o, high: runningHigh, low: runningLow, close: tick.price,
        color: "rgba(232,169,76,0.55)", borderColor: "#e8a94c", wickColor: "#e8a94c",
      });
      if (liveChart.volSeries) {
        liveChart.volSeries.update({ time: toUnix(formingBarObj.t), value: Math.round((formingBarObj.v || 0) * 0.6), color: "rgba(232,169,76,0.4)" });
      }
    }

    let i = -1, done = false, timer = null;
    function scheduleNext() {
      if (done) return;
      i++;
      if (i >= ticks.length) { complete(); return; }
      const tick = ticks[i];
      priceEl.textContent = "$" + fmtPrice(tick.price);
      secEl.textContent = `${unitLabel} ${i + 1} of ${ticks.length}`;
      fillEl.style.width = `${((i + 1) / ticks.length) * 100}%`;
      paintTick(tick);
      if (done) return; // paintTick can't finish us, but keep this future-proof
      if (opts.checkStop && opts.checkStop(tick.price, tick)) { stopTriggered(tick); return; }
      const baseDelay = tick.delayMs != null ? tick.delayMs : TICK_REAL_MS;
      const delay = Math.max(20, baseDelay / (state.replaySpeed || 1));
      timer = setTimeout(scheduleNext, delay);
    }
    function stopTriggered(tick) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
      opts.onStop && opts.onStop(tick, i);
    }
    function complete() {
      if (done) return;
      done = true;
      actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
      const lastTick = ticks.length ? ticks[ticks.length - 1] : null;
      opts.onAct && opts.onAct(opts.defaultActionId, ticks.length - 1, lastTick ? lastTick.price : null, lastTick);
    }
    function finish(actionId) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
      const idx = Math.max(0, i);
      const tick = ticks[idx] || null;
      opts.onAct && opts.onAct(actionId, idx, tick ? tick.price : null, tick);
    }
    scheduleNext();
    return { stop: () => { done = true; clearTimeout(timer); } };
  }

  // ---------------------------------------------------------------
  // Full entry->exit second-by-second replay, for the "↻ Replay
  // entry→exit" button on the reveal screen -- distinct from
  // runLiveReplay above, which drives the entry/live-trade tape (the
  // checkpoint) and drives forming-candle grading actions. This one
  // just animates a marker across the whole trade's already-rendered
  // reveal chart, purely for review, and can be re-clicked to watch it
  // again from the start as many times as you want.
  // ---------------------------------------------------------------
  function buildEntryExitTicks(trade, bars, entryIdx, exitIdx) {
    const entryUnix = toUnix(`${trade.trade_date} ${trade.entry_time}`);
    const exitUnix = toUnix(`${trade.trade_date} ${trade.exit_time}`);
    if (!Number.isFinite(entryUnix) || !Number.isFinite(exitUnix)) return [];
    const ticks = [];
    for (let idx = entryIdx; idx <= exitIdx; idx++) {
      const bar = bars[idx];
      const barStart = toUnix(bar.t);
      const prevClose = idx > 0 ? bars[idx - 1].c : bar.o;
      const prices = genSecondTicks(bar, prevClose, `${trade.id}:reveal:${bar.t}`);
      for (let s = 0; s < prices.length; s++) {
        const t = barStart + (s / prices.length) * 60;
        if (t < entryUnix || t > exitUnix) continue;
        ticks.push({ time: t, price: prices[s] });
      }
    }
    if (!ticks.length || ticks[0].time > entryUnix) ticks.unshift({ time: entryUnix, price: trade.entry_price });
    else { ticks[0].time = entryUnix; ticks[0].price = trade.entry_price; }
    if (ticks[ticks.length - 1].time < exitUnix) ticks.push({ time: exitUnix, price: trade.exit_price });
    else { ticks[ticks.length - 1].time = exitUnix; ticks[ticks.length - 1].price = trade.exit_price; }
    return ticks;
  }

  function setupRevealReplay(c, chartEl) {
    const btn = document.getElementById("qz-replay-again-btn");
    if (!btn) return;
    const ticks = buildEntryExitTicks(c.trade, c.bars, c.entryIdx, c.exitIdx);
    if (ticks.length < 2) { btn.disabled = true; return; }

    const dot = document.createElement("div");
    dot.style.cssText = `
      position:absolute; width:9px; height:9px; border-radius:50%;
      background:#ffd166; border:2px solid #14171c; z-index:6;
      pointer-events:none; display:none; transform:translate(-50%,-50%);
      box-shadow:0 0 0 2px rgba(255,209,102,0.35);
    `;
    chartEl.style.position = "relative";
    chartEl.appendChild(dot);

    function positionDot(tick) {
      try {
        const x = c.chartHandle.chart.timeScale().timeToCoordinate(Math.round(tick.time));
        const y = c.chartHandle.series.priceToCoordinate(tick.price);
        if (x == null || y == null) { dot.style.display = "none"; return; }
        dot.style.display = "block";
        dot.style.left = `${x}px`;
        dot.style.top = `${y}px`;
      } catch (e) { /* chart torn down mid-animation */ }
    }
    let timer = null, replayIdx = 0;
    c.chartHandle.chart.timeScale().subscribeVisibleLogicalRangeChange(() => positionDot(ticks[Math.min(replayIdx, ticks.length - 1)]));

    function stop() { if (timer) clearInterval(timer); timer = null; }
    // Total playback is meant to stay ~constant (a few seconds) no matter
    // how long the real trade was. Flooring the per-tick delay alone broke
    // that for long trades: with thousands of ticks and a 20ms floor, total
    // time grew to minutes instead of staying ~4s, making the button look
    // stuck on "Replaying…". Instead, keep the delay at the floor and skip
    // multiple ticks per frame so the number of frames -- and therefore the
    // total duration -- stays roughly fixed regardless of tick count.
    const TOTAL_MS = 4000;
    const FRAME_MS = 20;
    function play() {
      stop();
      replayIdx = 0;
      btn.disabled = true;
      btn.textContent = "▶ Replaying…";
      positionDot(ticks[0]);
      const maxFrames = Math.max(1, Math.floor(TOTAL_MS / FRAME_MS));
      const step = Math.max(1, Math.ceil(ticks.length / maxFrames));
      const frameCount = Math.max(1, Math.ceil(ticks.length / step));
      const delay = Math.max(FRAME_MS, Math.round(TOTAL_MS / frameCount));
      timer = setInterval(() => {
        replayIdx += step;
        if (replayIdx >= ticks.length) {
          positionDot(ticks[ticks.length - 1]);
          stop();
          btn.disabled = false;
          btn.textContent = "↻ Replay entry→exit";
          return;
        }
        positionDot(ticks[replayIdx]);
      }, delay);
    }
    btn.addEventListener("click", play);
  }

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveHistoryEntry(entry) {
    try {
      const list = loadHistory();
      list.push(entry);
      while (list.length > HISTORY_MAX) list.shift();
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch (e) { /* ignore — quiz still works without persistence */ }
  }

  // ---------------------------------------------------------------
  // boot: load the index, populate the setup screen
  // ---------------------------------------------------------------
  fetch("data/trades.json")
    .then((r) => (r.ok ? r.json() : []))
    .then((rows) => {
      state.index = Array.isArray(rows) ? rows : [];
      populateSetupOptions();
      renderCandidateCount();
      renderHistoryPanel();
    })
    .catch(() => {
      els.candidateCount.textContent = "Couldn't load data/trades.json.";
      els.startBtn.disabled = true;
    });

  function populateSetupOptions() {
    const setups = Array.from(new Set(state.index.map((r) => r.setup_type).filter(Boolean))).sort();
    for (const s of setups) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s.replace(/_/g, " ");
      els.setupSelect.appendChild(opt);
    }
  }

  function getFilters() {
    const countBtn = els.countRow.querySelector(".quiz-mode-btn.active");
    const tickBtn = els.tickModeRow.querySelector(".quiz-mode-btn.active");
    return {
      setup: els.setupSelect.value,
      result: els.resultSelect.value,
      count: countBtn ? Number(countBtn.dataset.count) : 10,
      blind: els.blindCheck.checked,
      tickMode: tickBtn ? tickBtn.dataset.tickmode : "sim",
    };
  }

  function filterIndex(filters) {
    return state.index.filter((r) => {
      if (!r.id) return false;
      if (filters.setup && r.setup_type !== filters.setup) return false;
      if (filters.result === "win" && !r.win) return false;
      if (filters.result === "loss" && r.win) return false;
      if (filters.result === "flagged" && !(r.better_entry_price != null || r.better_exit_price != null)) return false;
      return true;
    });
  }

  function renderCandidateCount() {
    const filters = getFilters();
    const n = filterIndex(filters).length;
    els.candidateCount.innerHTML = `<b>${n}</b> matching trade${n === 1 ? "" : "s"} in your journal.`;
    els.startBtn.disabled = n === 0;
  }

  els.setupSelect.addEventListener("change", renderCandidateCount);
  els.resultSelect.addEventListener("change", renderCandidateCount);
  els.countRow.querySelectorAll(".quiz-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.countRow.querySelectorAll(".quiz-mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderCandidateCount();
    });
  });
  els.tickModeRow.querySelectorAll(".quiz-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.tickModeRow.querySelectorAll(".quiz-mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      els.tickModeHint.style.display = btn.dataset.tickmode === "real" ? "" : "none";
    });
  });
  els.startBtn.addEventListener("click", () => {
    const filters = getFilters();
    state.lastFilters = filters;
    startQuiz(filters, filterIndex(filters).map((r) => r.id));
  });

  function renderHistoryPanel() {
    const history = loadHistory();
    if (!history.length) {
      els.historyBox.innerHTML = `<div class="quiz-history-empty">No quizzes taken yet — your accuracy trend will show up here.</div>`;
      els.focusBox.innerHTML = "";
      return;
    }
    const recent = history.slice(-8).reverse();
    els.historyBox.innerHTML = recent.map((h) => {
      const color = h.accuracy >= 70 ? "var(--green)" : h.accuracy >= 40 ? "var(--amber)" : "var(--red)";
      return `<div class="quiz-history-row">
        <span class="hr-date">${escapeHtml(h.date)}</span>
        <span class="hr-track"><span class="hr-fill" style="width:${Math.max(4, h.accuracy)}%; background:${color}"></span></span>
        <span class="hr-val" style="color:${color}">${h.accuracy}% · ${h.count}q</span>
      </div>`;
    }).join("");

    const missTotals = {};
    history.forEach((h) => {
      Object.entries(h.missedSetups || {}).forEach(([k, v]) => { missTotals[k] = (missTotals[k] || 0) + v; });
    });
    const top = Object.entries(missTotals).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (!top.length) { els.focusBox.innerHTML = ""; return; }
    els.focusBox.innerHTML = `<div class="panel-box-head" style="margin-bottom:8px;"><span class="title">Setups to review</span></div>
      <div class="quiz-focus-list">
        ${top.map(([setup, n]) => `<a class="quiz-focus-item" href="playbooks.html?setup=${encodeURIComponent(setup)}">
          <span>${escapeHtml(setup.replace(/_/g, " "))}</span>
          <span class="fi-count">missed ${n}×</span>
        </a>`).join("")}
      </div>`;
  }

  // ---------------------------------------------------------------
  // chart building — a slimmed-down version of trade.js's chart, since
  // the quiz only needs candles + volume + VWAP/EMA overlays, cropped
  // to whatever the current stage should reveal.
  // ---------------------------------------------------------------
  function buildChart(el, bars, opts) {
    opts = opts || {};
    el.innerHTML = "";
    const candleData = bars.map((b) => {
      const point = { time: toUnix(b.t), open: b.o, high: b.h, low: b.l, close: b.c };
      if (b._forming) { point.color = "rgba(232,169,76,0.55)"; point.borderColor = "#e8a94c"; point.wickColor = "#e8a94c"; }
      return point;
    });
    const volData = bars.map((b) => ({
      time: toUnix(b.t), value: b.v,
      color: b._forming ? "rgba(232,169,76,0.4)" : (b.c >= b.o ? "rgba(47,208,138,0.4)" : "rgba(242,85,90,0.4)"),
    }));
    const vwapData = bars.filter((b) => b.vwap != null).map((b) => ({ time: toUnix(b.t), value: b.vwap }));
    const ema9Data = bars.filter((b) => b.ema9 != null).map((b) => ({ time: toUnix(b.t), value: b.ema9 }));
    const ema20Data = bars.filter((b) => b.ema20 != null).map((b) => ({ time: toUnix(b.t), value: b.ema20 }));

    const commonOpts = {
      layout: { background: { color: "transparent" }, textColor: "#8b98a5" },
      grid: { vertLines: { color: "#1c2127" }, horzLines: { color: "#1c2127" } },
      rightPriceScale: { borderColor: "#232830", minimumWidth: 88 },
      timeScale: { borderColor: "#232830", timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    };
    const chart = LightweightCharts.createChart(el, { ...commonOpts, width: el.clientWidth, height: opts.height || 380 });
    const series = chart.addCandlestickSeries({
      upColor: "#2fd08a", downColor: "#f2555a", borderVisible: false,
      wickUpColor: "#2fd08a", wickDownColor: "#f2555a",
    });
    series.setData(candleData);
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.12, bottom: 0.2 } });

    const volSeries = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    volSeries.setData(volData);

    chart.addLineSeries({ color: "#e8a94c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(vwapData);
    chart.addLineSeries({ color: "#9aa8a1", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(ema9Data);
    chart.addLineSeries({ color: "#5b93f0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(ema20Data);

    if (opts.markers && opts.markers.length) series.setMarkers(opts.markers);
    const priceLineRefs = {};
    (opts.priceLines || []).forEach((pl, i) => {
      priceLineRefs[pl.key || i] = series.createPriceLine(pl);
    });

    chart.timeScale().fitContent();
    let ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => { try { chart.applyOptions({ width: el.clientWidth }); } catch (e) {} });
      ro.observe(el);
    }
    return { chart, series, volSeries, priceLineRefs, resizeObserver: ro };
  }
  function teardownChart(handle) {
    if (!handle) return;
    try { if (handle.resizeObserver) handle.resizeObserver.disconnect(); } catch (e) {}
    try { if (handle.pointerRo) handle.pointerRo.disconnect(); } catch (e) {}
    try { handle.chart.remove(); } catch (e) {}
  }

  // ---------------------------------------------------------------
  // exact-price pointer triangles -- the same look used on trade.html,
  // instead of lightweight-charts' native markers (which snap to a fixed
  // offset above/below the candle's own high/low, not the exact fill
  // price). A pointer's tip sits exactly where its price line is, so
  // there's only ever one thing marking a given price.
  //
  // Each pointer also owns a hover/tap tooltip with the exact price --
  // same behavior as trade.html. The tooltip is appended to `container`
  // directly rather than the (clipped) overlay, so it's never cut off at
  // the chart's edge.
  // ---------------------------------------------------------------
  const POINTER_H = 9;
  function attachPointers(container, chartHandle, pointerDefs) {
    const { chart, series } = chartHandle;
    container.style.position = "relative";
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:absolute; inset:0; pointer-events:none; overflow:hidden; z-index:2;";
    container.appendChild(overlay);

    const pointers = pointerDefs.map((p) => {
      const el = document.createElement("div");
      el.style.cssText = `
        position:absolute; width:0; height:0; pointer-events:auto;
        border-left:6px solid transparent; border-right:6px solid transparent;
        filter: drop-shadow(0 0 1.5px #0b0d10) drop-shadow(0 0 1.5px #0b0d10);
        border-top:${p.above ? `${POINTER_H}px solid ${p.color}` : "0"};
        border-bottom:${p.above ? "0" : `${POINTER_H}px solid ${p.color}`};
      `;
      overlay.appendChild(el);

      let tooltip = null;
      if (p.tooltip) {
        tooltip = document.createElement("div");
        tooltip.className = "pointer-tooltip";
        tooltip.dataset.open = "0";
        tooltip.style.cssText = `
          position:absolute; display:none; width:180px; max-width:60vw;
          background:#181b22; border:1px solid ${p.color}; border-radius:8px;
          padding:8px 10px; font-size:12px; line-height:1.5; color:#eceef2;
          box-shadow:0 6px 20px rgba(0,0,0,.45); z-index:5; pointer-events:none;
        `;
        tooltip.textContent = p.tooltip;
        container.appendChild(tooltip);

        const openTooltip = () => {
          container.querySelectorAll(".pointer-tooltip").forEach((t) => { t.dataset.open = "0"; t.style.display = "none"; });
          tooltip.dataset.open = "1";
          tooltip.style.display = "block";
          reposition();
        };
        const closeTooltip = () => { tooltip.dataset.open = "0"; tooltip.style.display = "none"; };
        el.addEventListener("mouseenter", openTooltip);
        el.addEventListener("mouseleave", closeTooltip);
        // Tap-to-toggle so touch users (no mouseenter) can still reach it.
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          if (tooltip.dataset.open === "1") closeTooltip(); else openTooltip();
        });
      }

      return { ...p, el, tooltip };
    });

    function reposition() {
      try {
        pointers.forEach((p) => {
          const x = chart.timeScale().timeToCoordinate(p.time);
          const y = series.priceToCoordinate(p.price);
          if (x == null || y == null) {
            p.el.style.display = "none";
            if (p.tooltip) { p.tooltip.style.display = "none"; p.tooltip.dataset.open = "0"; }
            return;
          }
          p.el.style.display = "block";
          p.el.style.left = `${x}px`;
          const pointerTop = p.above ? y - POINTER_H : y;
          p.el.style.top = `${pointerTop}px`;
          p.el.style.transform = "translateX(-50%)";
          if (p.tooltip && p.tooltip.dataset.open === "1") {
            p.tooltip.style.left = `${x + 8}px`;
            p.tooltip.style.top = `${p.above ? pointerTop - 8 : pointerTop + POINTER_H + 8}px`;
            p.tooltip.style.transform = p.above ? "translateY(-100%)" : "none";
          }
        });
      } catch (e) { /* chart already torn down */ }
    }

    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(reposition); ro.observe(container); }
    chart.timeScale().subscribeVisibleLogicalRangeChange(reposition);
    reposition();
    requestAnimationFrame(reposition);
    setTimeout(reposition, 0);
    chartHandle.pointerRo = ro;
  }

  // Any click outside a pointer tooltip closes whichever one is pinned
  // open -- otherwise a tapped-open tooltip would just sit there covering
  // the chart. Registered once here (not inside attachPointers) so it
  // doesn't pile up a duplicate listener on every question.
  document.addEventListener("click", () => {
    document.querySelectorAll(".pointer-tooltip").forEach((t) => { t.dataset.open = "0"; t.style.display = "none"; });
  });

  // ---------------------------------------------------------------
  // quiz flow
  // ---------------------------------------------------------------
  function startQuiz(filters, ids) {
    state.queue = shuffle(ids).slice(0, filters.count > 0 ? filters.count : ids.length);
    state.qIndex = 0;
    state.blind = filters.blind;
    state.tickMode = filters.tickMode === "real" ? "real" : "sim";
    state.results = [];
    state.streak = 0;
    els.setupScreen.style.display = "none";
    els.summaryScreen.style.display = "none";
    els.playScreen.style.display = "";
    loadQuestion();
  }

  function fetchDetail(id) {
    if (state.detailCache[id]) return Promise.resolve(state.detailCache[id]);
    return fetch(`data/trades/${encodeURIComponent(id)}.json`)
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((trade) => { state.detailCache[id] = trade; return trade; });
  }

  function updateHeaderChrome() {
    els.progressLabel.textContent = `Question ${Math.min(state.qIndex + 1, state.queue.length)} / ${state.queue.length}`;
    els.progressFill.style.width = `${(state.qIndex / state.queue.length) * 100}%`;
    const correct = state.results.filter((r) => r.entryCorrect).length;
    els.scoreChip.textContent = state.results.length ? `${correct}/${state.results.length} correct calls` : "";
    els.streak.textContent = state.streak >= 2 ? `🔥 ${state.streak} in a row` : "";
  }

  function loadQuestion() {
    if (state.current && state.current.replayHandle) state.current.replayHandle.stop();
    updateHeaderChrome();
    if (state.qIndex >= state.queue.length) { finishQuiz(); return; }
    els.card.innerHTML = `<div class="loading-line">Loading chart…</div>`;
    fetchDetail(state.queue[state.qIndex])
      .then((trade) => initQuestion(trade))
      .catch((err) => {
        els.card.innerHTML = `<div class="empty-state">Couldn't load this trade (${escapeHtml(String(err.message))}). <button class="btn-advanced" id="qz-skip">Skip it</button></div>`;
        const skip = document.getElementById("qz-skip");
        if (skip) skip.addEventListener("click", () => { state.qIndex++; loadQuestion(); });
      });
  }

  function initQuestion(trade) {
    const bars = Array.isArray(trade.bars) ? trade.bars : [];
    const side = trade.side === "short" ? "short" : "long";
    const entryUnix = toUnix(`${trade.trade_date} ${trade.entry_time}`);
    const exitUnix = toUnix(`${trade.trade_date} ${trade.exit_time}`);
    let entryIdx = barIndexAt(bars, entryUnix);
    let exitIdx = barIndexAt(bars, exitUnix);
    if (exitIdx <= entryIdx) exitIdx = Math.min(bars.length - 1, entryIdx + 1);

    state.current = {
      trade, bars, side, entryIdx, exitIdx,
      stage: "entry",
      entered: null,
      stopPrice: null,
      stoppedOutEarly: false,
      stopOutIdx: null,
      checkpointAction: null,
      exitAtBarIdx: null, // bar index at which the live stream ended (exit click, or ran out)
      chartHandle: null,
      replayHandle: null,
      userExitPrice: null,
      userShares: SIZE_BASELINE,
    };
    renderEntryStage();
  }

  function displayLabel(trade) {
    return state.blind
      ? { name: `Setup #${state.qIndex + 1}`, date: "" }
      : { name: trade.symbol, date: trade.trade_date };
  }

  // ---------- Stage A: entry decision ----------
  const BAR_SECONDS = 60; // data is 1-minute bars throughout

  function renderEntryStage() {
    const c = state.current;
    const trade = c.trade;
    const label = displayLabel(trade);
    const entryBar = c.bars[c.entryIdx];
    const entryUnix = toUnix(`${trade.trade_date} ${trade.entry_time}`);
    const secondsIntoBar = Math.max(0, entryUnix - toUnix(entryBar.t));
    const secondsRemaining = Math.max(0, BAR_SECONDS - secondsIntoBar);
    const visibleBars = c.bars.slice(0, c.entryIdx);
    const sidePretty = c.side === "short" ? "short" : "long";

    els.card.innerHTML = `
      <div class="quiz-card-head">
        <div class="quiz-symbol-line">
          <span>${escapeHtml(label.name)}</span>
          ${label.date ? `<span class="dim" style="font-weight:400; font-size:13px;">${escapeHtml(label.date)}</span>` : ""}
          <span class="side-pill ${sidePretty}">${sidePretty}</span>
          <span class="pill">${escapeHtml((trade.setup_type || "unlabeled setup").replace(/_/g, " "))}</span>
        </div>
        <span class="quiz-clock">${escapeHtml(trade.entry_time)}
          <span class="quiz-live-badge"><span class="quiz-live-dot"></span>${secondsRemaining}s left on this candle</span>
        </span>
      </div>
      <div class="quiz-chart-wrap"><div id="quiz-candle-chart"></div></div>
      <div class="quiz-prompt">
        This is a <b>${sidePretty}</b> setup. The tape is printing live below — <b>enter whenever you're ready</b>. It keeps running while you decide, so you're never stuck staring at a freeze-frame.
      </div>
      <div id="quiz-entry-replay-slot"><div class="quiz-replay-loading">${state.tickMode === "real" ? "Loading real ticks…" : "Loading…"}</div></div>
      <div class="quiz-answer-row">
        <button class="quiz-answer-btn enter" id="qz-enter">Enter the trade <span class="kbd">Y</span></button>
        <button class="quiz-answer-btn pass" id="qz-pass">Pass <span class="kbd">N</span></button>
      </div>
      <div id="quiz-stop-slot"></div>
    `;

    teardownChart(c.chartHandle);
    c.chartHandle = buildChart(document.getElementById("quiz-candle-chart"), visibleBars, { height: 380 });
    // Seed a zero-range candle for the forming bar so there's room for it
    // on the timescale before the first tick arrives.
    c.chartHandle.series.update({
      time: toUnix(entryBar.t), open: entryBar.o, high: entryBar.o, low: entryBar.o, close: entryBar.o,
      color: "rgba(232,169,76,0.55)", borderColor: "#e8a94c", wickColor: "#e8a94c",
    });
    try { c.chartHandle.chart.timeScale().fitContent(); } catch (e) {}

    document.getElementById("qz-enter").addEventListener("click", () => handleEntryChoice(true));
    document.getElementById("qz-pass").addEventListener("click", () => handleEntryChoice(false));

    // Auto-starts the instant this stage loads: a ~10-20s runway of tape
    // (real prints from the server, or the same simulated path used
    // elsewhere), paced against real elapsed time, ending right at the
    // fill. Enter/Pass stay clickable throughout; if you haven't acted by
    // the time playback reaches the fill, it just holds there and waits.
    const replaySlot = document.getElementById("quiz-entry-replay-slot");
    getEntryLeadInTicks(trade, c.bars, c.entryIdx, entryUnix, ENTRY_LEADIN_SECONDS).then(({ ticks, real, fellBack }) => {
      if (state.current !== c || c.stage !== "entry") return;
      c.replayHandle = runLiveReplay(replaySlot, ticks, {
        unitLabel: real ? "tick" : "second",
        tag: real ? "live ticks · server" : "simulated seconds",
        tagCls: real ? "live" : "",
        fallbackNote: fellBack ? "No live ticks came back for this window — showing the simulated path instead." : "",
        actions: [],
        defaultActionId: null,
        chartHandle: c.chartHandle,
        barLookup: (idx) => c.bars[idx],
        onAct: () => {},
      });
    });

    c.stage = "entry";
  }

  function handleEntryChoice(entered) {
    const c = state.current;
    if (c.replayHandle) { c.replayHandle.stop(); c.replayHandle = null; } // stop an in-progress "watch it print in" replay
    c.entered = entered;
    document.getElementById("qz-enter").disabled = true;
    document.getElementById("qz-pass").disabled = true;
    if (entered) renderStopStage();
    else goToReveal();
  }

  // ---------- Stage B: stop-loss + position size ----------
  function renderStopStage() {
    const c = state.current;
    const trade = c.trade;
    const entryPrice = trade.entry_price;
    const slot = document.getElementById("quiz-stop-slot");
    slot.innerHTML = `
      <div class="quiz-stop-panel">
        <div class="quiz-prompt" style="margin-top:0;">You're in. <b>Where's your stop-loss?</b> Pick a quick option, type a price, or click the chart to place it.</div>
        <div class="quiz-preset-row" id="quiz-stop-presets">
          ${STOP_PRESETS.map((p) => `<button class="quiz-preset-btn" data-pct="${p.pct}">${p.label} <span class="dim">· ${p.sub}</span></button>`).join("")}
          <button class="quiz-preset-btn active" data-pct="">Custom</button>
        </div>
        <div class="quiz-stop-row">
          <input type="number" step="0.0001" id="quiz-stop-input" placeholder="e.g. ${fmtPrice(c.side === "short" ? entryPrice * 1.02 : entryPrice * 0.98)}">
        </div>
        <div class="quiz-risk-preview" id="quiz-risk-preview"></div>

        <div class="quiz-prompt">
          <b>How much size?</b> Size up on trades you like, size down on ones you're not sure about — pick a quick option or set your own.
        </div>
        <div class="quiz-preset-row" id="quiz-size-presets">
          ${SIZE_PRESETS.map((p) => `<button class="quiz-preset-btn${p.shares === SIZE_BASELINE ? " active" : ""}" data-shares="${p.shares}">${p.label} <span class="dim">· ${p.sub}</span></button>`).join("")}
          <button class="quiz-preset-btn" data-shares="">Custom</button>
        </div>
        <div class="quiz-size-row">
          <input type="number" step="1" min="1" id="quiz-size-input" value="${SIZE_BASELINE}">
          <span class="quiz-size-unit">shares</span>
        </div>
        <div class="quiz-size-preview" id="quiz-size-risk-preview"></div>

        <div class="quiz-stop-row" style="margin-top:16px;">
          <button class="quiz-answer-btn enter" id="quiz-stop-confirm" style="flex:none; min-width:190px;">Lock in stop &amp; size <span class="kbd">↵</span></button>
        </div>
        <div class="quiz-stop-hint" id="quiz-stop-error"></div>
      </div>
    `;
    c.stage = "stop";

    const input = document.getElementById("quiz-stop-input");
    const sizeInput = document.getElementById("quiz-size-input");
    const stopPresetBtns = Array.from(document.querySelectorAll("#quiz-stop-presets .quiz-preset-btn"));
    const sizePresetBtns = Array.from(document.querySelectorAll("#quiz-size-presets .quiz-preset-btn"));

    let previewLine = null;
    function updateSizeRiskPreview() {
      const el = document.getElementById("quiz-size-risk-preview");
      if (!el) return;
      const shares = Number(sizeInput.value);
      const price = Number(input.value);
      const risk = c.side === "short" ? price - entryPrice : entryPrice - price;
      el.textContent = (Number.isFinite(shares) && shares > 0 && risk > 0)
        ? `Total risk if stopped: $${(risk * shares).toFixed(2)} across ${shares} sh.`
        : "";
    }
    function setPreview(price) {
      if (!Number.isFinite(price)) return;
      if (previewLine) previewLine.applyOptions({ price });
      else previewLine = c.chartHandle.series.createPriceLine({
        price, color: "#c9cdd6", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: true, title: "your stop",
      });
      const risk = c.side === "short" ? price - entryPrice : entryPrice - price;
      const el = document.getElementById("quiz-risk-preview");
      if (el) el.textContent = risk > 0
        ? `Risking $${fmtPrice(risk)}/sh (${((risk / entryPrice) * 100).toFixed(1)}%) if filled at $${fmtPrice(entryPrice)}.`
        : `That's on the wrong side of your entry ($${fmtPrice(entryPrice)}) — widen it out.`;
      updateSizeRiskPreview();
    }

    stopPresetBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        stopPresetBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const pct = Number(btn.dataset.pct);
        if (pct) {
          const mult = c.side === "short" ? 1 + pct / 100 : 1 - pct / 100;
          const price = entryPrice * mult;
          input.value = fmtPrice(price);
          setPreview(price);
        } else {
          input.focus();
        }
      });
    });
    sizePresetBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        sizePresetBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const shares = btn.dataset.shares;
        if (shares) { sizeInput.value = shares; updateSizeRiskPreview(); }
        else { sizeInput.focus(); sizeInput.select(); }
      });
    });

    input.addEventListener("input", () => {
      stopPresetBtns.forEach((b) => b.classList.toggle("active", b.dataset.pct === ""));
      setPreview(Number(input.value));
    });
    sizeInput.addEventListener("input", () => {
      sizePresetBtns.forEach((b) => b.classList.toggle("active", b.dataset.shares === ""));
      updateSizeRiskPreview();
    });
    c.chartHandle.chart.subscribeClick((param) => {
      if (!param.point || !c.chartHandle.series) return;
      const price = c.chartHandle.series.coordinateToPrice(param.point.y);
      if (price == null) return;
      input.value = fmtPrice(price);
      stopPresetBtns.forEach((b) => b.classList.toggle("active", b.dataset.pct === ""));
      setPreview(price);
    });

    document.getElementById("quiz-stop-confirm").addEventListener("click", () => {
      const price = Number(input.value);
      const shares = Number(sizeInput.value);
      const errorEl = document.getElementById("quiz-stop-error");
      if (!Number.isFinite(price) || price <= 0) { errorEl.textContent = "Enter a valid stop price first."; return; }
      const risk = c.side === "short" ? price - entryPrice : entryPrice - price;
      if (!(risk > 0)) { errorEl.textContent = `That stop is on the wrong side of your $${fmtPrice(entryPrice)} entry for a ${c.side}.`; return; }
      if (!Number.isFinite(shares) || shares <= 0) { errorEl.textContent = "Enter a valid share size too."; return; }
      c.userShares = Math.round(shares);
      confirmStop(price);
    });
  }

  function confirmStop(stopPrice) {
    const c = state.current;
    c.stopPrice = stopPrice;
    const slot = document.getElementById("quiz-stop-slot");
    if (slot) slot.querySelectorAll("button, input").forEach((elm) => (elm.disabled = true));

    if (c.entryIdx >= c.exitIdx) {
      // Entry landed on the very last bar we have -- no room to stream
      // anything between entry and exit.
      goToReveal();
      return;
    }
    renderLiveTradeStage();
  }

  // ---------- Stage C: live post-entry stream ----------
  // Ticks continuously from the fill (picking up exactly where the entry
  // stage's tape left off) all the way to the real exit bar, checking every
  // tick against your stop as it prints. You exit whenever you decide to;
  // if you never click and the stop never gets hit, it resolves as holding
  // to the real exit once the tape runs out.
  function renderLiveTradeStage() {
    const c = state.current;
    const trade = c.trade;
    const entryPrice = trade.entry_price;
    const entryBar = c.bars[c.entryIdx];
    const entryUnix = toUnix(`${trade.trade_date} ${trade.entry_time}`);
    const historyBars = c.bars.slice(0, c.entryIdx); // entry bar itself keeps forming live below

    els.card.innerHTML = `
      <div class="quiz-card-head">
        <div class="quiz-symbol-line">
          <span>${escapeHtml(displayLabel(trade).name)}</span>
          <span class="side-pill ${c.side}">${c.side}</span>
        </div>
        <span class="quiz-clock">${escapeHtml(trade.entry_time)}</span>
      </div>
      <div class="quiz-chart-wrap"><div id="quiz-candle-chart"></div></div>
      <div class="quiz-prompt">
        You're in at <b>$${fmtPrice(entryPrice)}</b>, stop at <b>$${fmtPrice(c.stopPrice)}</b>.
        The tape keeps running from here — <b>click when you'd exit</b>, or let it ride. A stop hit is enforced live.
      </div>
      <div id="quiz-replay-slot"><div class="quiz-replay-loading">${state.tickMode === "real" ? "Loading real ticks from the server…" : "Loading…"}</div></div>
    `;
    c.stage = "checkpoint"; // keeps the existing keyboard-shortcut / in-flight guards working

    teardownChart(c.chartHandle);
    c.chartHandle = buildChart(document.getElementById("quiz-candle-chart"), historyBars, {
      height: 380,
      priceLines: [
        { price: entryPrice, color: "#2fd08a", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "" },
        { price: c.stopPrice, color: "#c9cdd6", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: "your stop" },
      ],
    });
    // Seed the entry bar's candle right where it stood at the fill --
    // the stream then continues its wick/close from exactly there.
    c.chartHandle.series.update({
      time: toUnix(entryBar.t), open: entryBar.o,
      high: Math.max(entryBar.o, entryPrice), low: Math.min(entryBar.o, entryPrice), close: entryPrice,
      color: "rgba(232,169,76,0.55)", borderColor: "#e8a94c", wickColor: "#e8a94c",
    });
    try { c.chartHandle.chart.timeScale().fitContent(); } catch (e) {}

    const replaySlot = document.getElementById("quiz-replay-slot");
    getPostEntryLiveTicks(trade, c.bars, c.entryIdx, entryUnix, c.exitIdx).then(({ ticks, real, fellBack }) => {
      if (state.current !== c || c.stage !== "checkpoint") return; // moved on while this was in flight
      c.replayHandle = runLiveReplay(replaySlot, ticks, {
        unitLabel: real ? "tick" : "second",
        tag: real ? "live ticks · server" : "simulated seconds",
        tagCls: real ? "live" : "",
        fallbackNote: fellBack ? "No live ticks came back for this window — showing the simulated path instead." : "",
        actions: [
          { id: "exit", label: "Exit now", kbd: "E", cls: "exit" },
          { id: "hold", label: "Hold to real exit", kbd: "H", cls: "hold" },
        ],
        defaultActionId: "hold",
        chartHandle: c.chartHandle,
        barLookup: (idx) => c.bars[idx],
        checkStop: (price) => (c.side === "short" ? price >= c.stopPrice : price <= c.stopPrice),
        onStop: (tick) => {
          c.stoppedOutEarly = true;
          c.stopOutIdx = tick.barIdx;
          goToReveal();
        },
        onAct: (actionId, idx, price, tick) => {
          c.checkpointAction = actionId;
          c.exitAtBarIdx = tick ? tick.barIdx : c.exitIdx;
          c.userExitPrice = actionId === "exit" ? price : null;
          goToReveal();
        },
      });
    });
  }

  // ---------- grading ----------
  function gradeEntry(win, entered) {
    if (entered && win) return { label: "Good call — this one was a real winner.", tone: "good", correct: true };
    if (entered && !win) return { label: "This one lost in real life too.", tone: "bad", correct: false };
    if (!entered && !win) return { label: "Good discipline — this one was a loser.", tone: "good", correct: true };
    return { label: "This one worked out — you'd have missed it.", tone: "warn", correct: false };
  }

  function gradeStop(side, entryPrice, stopPrice, suggestedStop) {
    const riskUser = side === "short" ? stopPrice - entryPrice : entryPrice - stopPrice;
    if (!(riskUser > 0)) return { label: "Stop was on the wrong side of your entry.", tone: "bad" };
    const sug = Number(suggestedStop);
    if (suggestedStop != null && Number.isFinite(sug)) {
      const riskSuggested = side === "short" ? sug - entryPrice : entryPrice - sug;
      if (riskSuggested > 0) {
        const ratio = riskUser / riskSuggested;
        if (ratio < 0.5) return { label: "Too tight — likely shaken out by normal noise.", tone: "bad" };
        if (ratio < 0.8) return { label: "A little tight versus the setup's stop.", tone: "warn" };
        if (ratio <= 1.3) return { label: "Well placed — close to the setup's stop.", tone: "good" };
        if (ratio <= 2.2) return { label: "A bit wide.", tone: "warn" };
        return { label: "Too wide — risking more than the setup called for.", tone: "bad" };
      }
    }
    const pct = (riskUser / entryPrice) * 100;
    return { label: `${pct.toFixed(1)}% risk — no AI stop logged on this trade to compare against.`, tone: "neutral" };
  }

  function computeGrading(c) {
    const trade = c.trade;
    const side = c.side;
    const entryPrice = trade.entry_price;
    const win = !!trade.win;
    const entryGrade = gradeEntry(win, c.entered);

    let stopGrade = null, exitGrade = null, userPnlPerShare = null;
    if (c.entered) {
      stopGrade = gradeStop(side, entryPrice, c.stopPrice, trade.suggested_stop);
      const actualPnl = pnlPerShare(entryPrice, trade.exit_price, side);

      if (c.stoppedOutEarly) {
        userPnlPerShare = pnlPerShare(entryPrice, c.stopPrice, side);
        exitGrade = { label: `Stopped out live, at $${fmtPrice(c.stopPrice)}.`, tone: "warn" };
      } else if (!c.checkpointAction) {
        userPnlPerShare = actualPnl;
        exitGrade = { label: "Not enough room between entry and exit for a live stream on this one — it went straight to the real exit.", tone: "neutral" };
      } else if (c.checkpointAction === "exit") {
        const exitBar = c.bars[c.exitAtBarIdx != null ? c.exitAtBarIdx : c.exitIdx];
        const exitPrice = Number.isFinite(c.userExitPrice) ? c.userExitPrice : exitBar.c;
        userPnlPerShare = pnlPerShare(entryPrice, exitPrice, side);
        const diff = actualPnl - userPnlPerShare;
        const threshold = Math.max(0.15 * Math.abs(actualPnl || 0.01), 0.01);
        if (diff > threshold) exitGrade = { label: `You exited early — the move kept going. Riding it to the real exit made ${fmtSignedPerShare(diff)}/sh more.`, tone: "warn" };
        else if (diff < -threshold) exitGrade = { label: "Good exit — price gave back a lot of that move afterward.", tone: "good" };
        else exitGrade = { label: "Reasonable exit, close to how the trade actually played out.", tone: "good" };
      } else {
        // Held all the way through -- the live stream already checked
        // every tick against your stop as it printed, so reaching here
        // (rather than the stoppedOutEarly branch above) means it never
        // would have been hit before the real exit.
        userPnlPerShare = actualPnl;
        exitGrade = { label: "You held on — matches what actually happened.", tone: "neutral" };
      }
    }

    // Size grading is independent of how the entry/stop/exit played out --
    // it's just: did your conviction (bigger size = more confident) line up
    // with how the trade actually turned out?
    let sizeGrade = null;
    if (c.entered && Number.isFinite(c.userShares)) {
      const ratio = c.userShares / SIZE_BASELINE;
      if (ratio >= 1.3 && win) sizeGrade = { label: `Sized up to ${c.userShares} sh and it paid off — good conviction.`, tone: "good" };
      else if (ratio >= 1.3 && !win) sizeGrade = { label: `Sized up to ${c.userShares} sh on a loser — that conviction cost you more.`, tone: "bad" };
      else if (ratio <= 0.7 && !win) sizeGrade = { label: `Sized down to ${c.userShares} sh — good instinct, this one lost.`, tone: "good" };
      else if (ratio <= 0.7 && win) sizeGrade = { label: `Sized down to ${c.userShares} sh on a winner — left size on the table.`, tone: "warn" };
      else sizeGrade = { label: `Standard size (${c.userShares} sh).`, tone: "neutral" };
    }

    return { entryGrade, stopGrade, exitGrade, sizeGrade, userPnlPerShare };
  }

  // ---------- Stage D: full reveal ----------
  function goToReveal() {
    const c = state.current;
    const trade = c.trade;
    const grading = computeGrading(c);
    c.stage = "reveal";

    state.results.push({
      id: trade.id, symbol: trade.symbol, setup_type: trade.setup_type, win: !!trade.win,
      entered: c.entered, entryCorrect: grading.entryGrade.correct,
      stopTone: grading.stopGrade ? grading.stopGrade.tone : null,
      exitTone: grading.exitGrade ? grading.exitGrade.tone : null,
      sizeTone: grading.sizeGrade ? grading.sizeGrade.tone : null,
    });
    state.streak = grading.entryGrade.correct ? state.streak + 1 : 0;

    const entryBar = c.bars[c.entryIdx], exitBar = c.bars[c.exitIdx];

    // The real entry/exit fills, your own stop (if you had one), and
    // whatever you actually did at exit time -- each gets both a
    // full-width price line (so the level is easy to read off the right
    // axis) and a pointer triangle sitting exactly on the fill (so the
    // exact bar/time is unambiguous too), same combination trade.html
    // uses. AI stop/target and better-entry/exit stay in the text panels
    // below rather than adding more lines to the chart.
    const pointerDefs = [
      { time: toUnix(entryBar.t), price: trade.entry_price, color: "#2fd08a", above: true, tooltip: `ENTRY $${fmtPrice(trade.entry_price)}` },
      { time: toUnix(exitBar.t), price: trade.exit_price, color: "#f2555a", above: false, tooltip: `EXIT $${fmtPrice(trade.exit_price)}` },
    ];
    if (c.stoppedOutEarly && c.stopOutIdx != null) {
      pointerDefs.push({ time: toUnix(c.bars[c.stopOutIdx].t), price: c.stopPrice, color: "#e8a94c", above: false, tooltip: `STOPPED OUT $${fmtPrice(c.stopPrice)}` });
    } else if (c.entered && c.checkpointAction === "exit" && c.exitAtBarIdx != null) {
      const exitBar = c.bars[c.exitAtBarIdx];
      const exitPx = Number.isFinite(c.userExitPrice) ? c.userExitPrice : exitBar.c;
      pointerDefs.push({ time: toUnix(exitBar.t), price: exitPx, color: "#5b93f0", above: false, tooltip: `YOUR EXIT $${fmtPrice(exitPx)}` });
    }

    const priceLines = [
      { price: trade.entry_price, color: "#2fd08a", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "" },
      { price: trade.exit_price, color: "#f2555a", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "" },
    ];
    if (c.entered && c.stopPrice != null) {
      priceLines.push({ price: c.stopPrice, color: "#c9cdd6", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: "your stop" });
    }

    const label = { name: trade.symbol, date: trade.trade_date }; // reveal always shows the real thing
    const winPillHtml = `<span class="pill ${trade.win ? "win" : "loss"}">${trade.win ? "Winner" : "Loser"}</span>`;

    function pillFor(tone) { return `pill ${tone === "good" ? "good" : tone === "bad" ? "bad" : tone === "warn" ? "warn" : "neutral"}`; }

    const entryRowHtml = `<div class="rb-line">You: <b>${c.entered ? "Entered" : "Passed"}</b></div>
      <div class="rb-line"><span class="${pillFor(grading.entryGrade.tone)}">${escapeHtml(grading.entryGrade.label)}</span></div>`;

    const sugStopSane = Number.isFinite(Number(trade.suggested_stop)) && (c.side === "short" ? Number(trade.suggested_stop) > trade.entry_price : Number(trade.suggested_stop) < trade.entry_price);
    const stopRowHtml = grading.stopGrade
      ? `<div class="rb-line">You placed your stop at <b>$${fmtPrice(c.stopPrice)}</b>${sugStopSane ? ` · AI suggested <b>$${fmtPrice(trade.suggested_stop)}</b>` : ""}</div>
         <div class="rb-line"><span class="${pillFor(grading.stopGrade.tone)}">${escapeHtml(grading.stopGrade.label)}</span></div>`
      : `<div class="rb-line dim">You passed, so no stop to grade.</div>`;

    const exitRowHtml = grading.exitGrade
      ? `<div class="rb-line">Your result: <b style="color:${grading.userPnlPerShare >= 0 ? "var(--green)" : "var(--red)"}">${fmtSignedPerShare(grading.userPnlPerShare)}/sh</b>
           · Actual: <b style="color:${trade.win ? "var(--green)" : "var(--red)"}">${fmtSignedPerShare(pnlPerShare(trade.entry_price, trade.exit_price, c.side))}/sh</b></div>
         <div class="rb-line"><span class="${pillFor(grading.exitGrade.tone)}">${escapeHtml(grading.exitGrade.label)}</span></div>`
      : `<div class="rb-line dim">You passed, so no exit to grade.</div>`;

    const sizeRowHtml = grading.sizeGrade
      ? `<div class="rb-line">You sized: <b>${c.userShares} sh</b> <span class="dim">(actual trade: ${trade.shares} sh)</span></div>
         <div class="rb-line"><span class="${pillFor(grading.sizeGrade.tone)}">${escapeHtml(grading.sizeGrade.label)}</span></div>`
      : `<div class="rb-line dim">You passed, so no size to grade.</div>`;

    // "Real numbers" -- the actual trade's fill/commission/timing, plus what
    // those same numbers would've looked like at the share size you picked
    // (commission scaled off the actual trade's own $/share commission rate,
    // since that's the only rate we actually have logged).
    const tradeCommission = Number(trade.commission) || 0;
    const tradeShares = Number(trade.shares) || 0;
    const commissionPerShare = tradeShares > 0 ? tradeCommission / tradeShares : 0;
    const userGross = c.entered && Number.isFinite(grading.userPnlPerShare) ? grading.userPnlPerShare * c.userShares : null;
    const userCommission = c.entered ? commissionPerShare * c.userShares : null;
    const userNet = (userGross != null && userCommission != null) ? userGross - userCommission : null;

    const lessonsHtml = (trade.lessons || []).map((l) => {
      if (typeof l === "string") return `<li>${escapeHtml(l)}</li>`;
      const how = l.how_to_know ? ` <span class="dim">— ${escapeHtml(l.how_to_know)}</span>` : "";
      return `<li><b>${escapeHtml((l.tag || "").replace(/_/g, " "))}</b>: ${escapeHtml(l.lesson || l.text || "")}${how}</li>`;
    }).join("");

    const isLast = state.qIndex >= state.queue.length - 1;

    els.card.innerHTML = `
      <div class="quiz-card-head">
        <div class="quiz-symbol-line">
          <span>${escapeHtml(label.name)}</span>
          <span class="dim" style="font-weight:400; font-size:13px;">${escapeHtml(label.date)}</span>
          <span class="side-pill ${c.side}">${c.side}</span>
          <span class="pill">${escapeHtml((trade.setup_type || "unlabeled setup").replace(/_/g, " "))}</span>
          ${winPillHtml}
        </div>
      </div>
      <div class="quiz-chart-wrap"><div id="quiz-candle-chart"></div></div>

      <div class="quiz-reveal-grid">
        <div class="quiz-reveal-box"><div class="rb-label">Entry</div>${entryRowHtml}</div>
        <div class="quiz-reveal-box"><div class="rb-label">Stop-loss</div>${stopRowHtml}</div>
        <div class="quiz-reveal-box"><div class="rb-label">Exit</div>${exitRowHtml}</div>
        <div class="quiz-reveal-box"><div class="rb-label">Position size</div>${sizeRowHtml}</div>
        <div class="quiz-reveal-box" style="grid-column:1/-1;"><div class="rb-label">Real numbers</div>
          <div class="rb-line">Entry <b>$${fmtPrice(trade.entry_price)}</b> at <b>${escapeHtml(trade.entry_time)}</b> → Exit <b>$${fmtPrice(trade.exit_price)}</b> at <b>${escapeHtml(trade.exit_time)}</b> <span class="dim">(${escapeHtml(trade.time_in_trade || "—")} in trade)</span></div>
          <div class="rb-line">Shares: <b>${tradeShares}</b> actual${c.entered ? ` · <b>${c.userShares}</b> yours` : ""} &nbsp;·&nbsp; Commission: <b>$${tradeCommission.toFixed(2)}</b> actual${c.entered && userCommission != null ? ` · <b>$${userCommission.toFixed(2)}</b> yours` : ""}</div>
          <div class="rb-line">Net P&amp;L: <b style="color:${trade.pnl_after_comm >= 0 ? "var(--green)" : "var(--red)"}">${trade.pnl_after_comm >= 0 ? "+" : "-"}$${Math.abs(trade.pnl_after_comm).toFixed(2)}</b> actual${c.entered && userNet != null ? ` · <b style="color:${userNet >= 0 ? "var(--green)" : "var(--red)"}">${userNet >= 0 ? "+" : "-"}$${Math.abs(userNet).toFixed(2)}</b> yours` : ""}</div>
        </div>
      </div>

      ${trade.verdict ? `<div class="quiz-verdict-box"><span class="vb-label">What actually happened</span>${escapeHtml(trade.verdict)}</div>` : ""}
      ${lessonsHtml ? `<ul class="quiz-lesson-list">${lessonsHtml}</ul>` : ""}
      ${trade.walk_away_rule ? `<div class="quiz-walkaway"><b>Walk-away rule:</b> ${escapeHtml(trade.walk_away_rule)}</div>` : ""}

      <div class="quiz-next-row">
        <button class="btn-advanced" id="qz-replay-again-btn" type="button">↻ Replay entry→exit</button>
        <a class="btn-advanced" href="trade.html?id=${encodeURIComponent(trade.id)}" target="_blank" rel="noopener">Open full trade page</a>
        <button class="btn-confirm" id="qz-next">${isLast ? "See results" : "Next question"} <span class="kbd">↵</span></button>
      </div>
    `;

    teardownChart(c.chartHandle);
    const chartEl = document.getElementById("quiz-candle-chart");
    c.chartHandle = buildChart(chartEl, c.bars, { height: 400, priceLines });
    attachPointers(chartEl, c.chartHandle, pointerDefs);
    setupRevealReplay(c, chartEl);

    document.getElementById("qz-next").addEventListener("click", () => { state.qIndex++; loadQuestion(); });
  }

  // ---------------------------------------------------------------
  // keyboard shortcuts — ignored while typing in the stop input
  // ---------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    if (els.playScreen.style.display === "none") return;
    const c = state.current;
    if (!c) return;
    const typing = document.activeElement && document.activeElement.tagName === "INPUT";
    if (c.stage === "entry" && !typing) {
      if (e.key === "y" || e.key === "Y" || e.key === "Enter") document.getElementById("qz-enter")?.click();
      if (e.key === "n" || e.key === "N" || e.key === "Escape") document.getElementById("qz-pass")?.click();
    } else if (c.stage === "checkpoint" && !typing) {
      if (e.key === "e" || e.key === "E" || e.key === "1") document.getElementById("qz-exit")?.click();
      if (e.key === "h" || e.key === "H" || e.key === "2") document.getElementById("qz-hold")?.click();
    } else if (c.stage === "reveal" && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      document.getElementById("qz-next")?.click();
    }
  });

  els.quitBtn.addEventListener("click", () => {
    if (!confirm("End this quiz? Your progress on the current question won't be saved.")) return;
    goToSetupScreen();
  });

  function goToSetupScreen() {
    if (state.current && state.current.chartHandle) teardownChart(state.current.chartHandle);
    if (state.current && state.current.replayHandle) state.current.replayHandle.stop();
    state.current = null;
    els.playScreen.style.display = "none";
    els.summaryScreen.style.display = "none";
    els.setupScreen.style.display = "";
    renderHistoryPanel();
    renderCandidateCount();
  }

  // ---------------------------------------------------------------
  // session summary
  // ---------------------------------------------------------------
  function finishQuiz() {
    els.playScreen.style.display = "none";
    els.summaryScreen.style.display = "";

    const total = state.results.length;
    const correct = state.results.filter((r) => r.entryCorrect).length;
    const accuracy = total ? Math.round((correct / total) * 100) : 0;
    const color = accuracy >= 70 ? "var(--green)" : accuracy >= 40 ? "var(--amber)" : "var(--red)";
    const r = 58, circ = 2 * Math.PI * r;
    const dash = (accuracy / 100) * circ;

    els.scoreWrap.innerHTML = `
      <div class="score-gauge">
        <svg viewBox="0 0 132 132">
          <circle class="track" cx="66" cy="66" r="${r}"></circle>
          <circle class="fill" cx="66" cy="66" r="${r}" stroke="${color}" stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}"></circle>
        </svg>
        <div class="center">
          <span class="num" style="color:${color}">${accuracy}</span>
          <span class="lbl">Read score</span>
        </div>
      </div>
      <div class="score-breakdown">
        <div class="score-row"><span class="k">Entry calls</span>
          <span class="track"><span class="fill" style="width:${Math.max(4, accuracy)}%; background:${color}"></span></span>
          <span class="v">${correct}/${total}</span>
        </div>
      </div>
    `;

    function tally(field) {
      const t = { good: 0, warn: 0, bad: 0, neutral: 0 };
      state.results.forEach((r) => { if (r[field]) t[r[field]] = (t[r[field]] || 0) + 1; });
      return t;
    }
    const stopTally = tally("stopTone");
    const exitTally = tally("exitTone");
    const sizeTally = tally("sizeTone");
    function chipsHtml(t) {
      const parts = [];
      if (t.good) parts.push(`<span class="pill good">${t.good} good</span>`);
      if (t.warn) parts.push(`<span class="pill warn">${t.warn} off</span>`);
      if (t.bad) parts.push(`<span class="pill bad">${t.bad} bad</span>`);
      if (t.neutral) parts.push(`<span class="pill neutral">${t.neutral} n/a</span>`);
      return parts.join(" ") || `<span class="dim">—</span>`;
    }
    els.breakdown.innerHTML = `
      <div class="quiz-breakdown-row"><span class="br-k">Stop placement</span><span class="br-chips">${chipsHtml(stopTally)}</span></div>
      <div class="quiz-breakdown-row"><span class="br-k">Exit timing</span><span class="br-chips">${chipsHtml(exitTally)}</span></div>
      <div class="quiz-breakdown-row"><span class="br-k">Position sizing</span><span class="br-chips">${chipsHtml(sizeTally)}</span></div>
    `;

    els.review.innerHTML = `
      <table class="quiz-review-table">
        <thead><tr><th>Symbol</th><th>Setup</th><th>Outcome</th><th>Your call</th><th>Stop</th><th>Exit</th><th></th></tr></thead>
        <tbody>
          ${state.results.map((r) => `<tr>
            <td>${escapeHtml(r.symbol)}</td>
            <td>${escapeHtml((r.setup_type || "—").replace(/_/g, " "))}</td>
            <td><span class="pill ${r.win ? "win" : "loss"}">${r.win ? "Win" : "Loss"}</span></td>
            <td>${r.entryCorrect ? "✅" : "❌"} ${r.entered ? "Entered" : "Passed"}</td>
            <td>${r.stopTone ? `<span class="pill ${r.stopTone === "good" ? "good" : r.stopTone === "bad" ? "bad" : r.stopTone === "warn" ? "warn" : "neutral"}">${escapeHtml(r.stopTone)}</span>` : "—"}</td>
            <td>${r.exitTone ? `<span class="pill ${r.exitTone === "good" ? "good" : r.exitTone === "bad" ? "bad" : r.exitTone === "warn" ? "warn" : "neutral"}">${escapeHtml(r.exitTone)}</span>` : "—"}</td>
            <td><a href="trade.html?id=${encodeURIComponent(r.id)}" target="_blank" rel="noopener">view</a></td>
          </tr>`).join("")}
        </tbody>
      </table>
    `;

    const missedSetups = {};
    state.results.forEach((r) => { if (!r.entryCorrect) missedSetups[r.setup_type || "unspecified"] = (missedSetups[r.setup_type || "unspecified"] || 0) + 1; });
    saveHistoryEntry({ date: new Date().toISOString().slice(0, 10), count: total, accuracy, missedSetups });
  }

  els.againBtn.addEventListener("click", () => {
    const filters = state.lastFilters || getFilters();
    startQuiz(filters, filterIndex(filters).map((r) => r.id));
  });
  els.reviewMissedBtn.addEventListener("click", () => {
    const missedIds = state.results.filter((r) => !r.entryCorrect).map((r) => r.id);
    if (!missedIds.length) { alert("Nothing to review — you called every entry right!"); return; }
    const filters = state.lastFilters || getFilters();
    startQuiz(filters, missedIds);
  });
  els.backToSetupBtn.addEventListener("click", goToSetupScreen);

})();
