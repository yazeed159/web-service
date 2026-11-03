(function () {
  "use strict";
  const R = (window.RewindKit = window.RewindKit || {});
  const { BAR_SECONDS, els, state } = R;
  const renderCandidateCount = (...args) => R.renderCandidateCount(...args);

  // ---------------------------------------------------------------
  // second-by-second replay — free-tier Polygon only gives us 1-min
  // bars (second aggregates and raw trades are a paid-tier feature),
  // so there's no real tick feed to draw on. Instead we synthesize a
  // plausible intra-bar path: a deterministic (seeded, so a given bar
  // always replays the same way) walk from the previous close through
  // the bar's open, its high/low (order randomized per bar, since
  // either order is consistent with the same OHLC print), and its
  // close.
  //
  // Two things make this look more like real prints than a straight
  // ramp-plus-static-jitter walk:
  //   - extra randomized waypoints between the OHLC anchors, so the
  //     path wanders instead of tracing dead-straight lines between
  //     four fixed points
  //   - noise is a smoothed (exponentially-decayed) random walk, not
  //     independent per-tick jitter, since real prints drift rather
  //     than teleport tick to tick; its amplitude also scales with the
  //     bar's own volume relative to this session's average, so a
  //     busy bar reads choppier than a quiet one instead of every bar
  //     looking equally jittery
  //
  // Still clearly labeled as simulated in the UI — this is a practice
  // aid, not real ticks. Used for the checkpoint/exit stage only — the
  // entry stage keeps its forming-candle + live countdown badge look.
  // ---------------------------------------------------------------
  // seededRng() now in utils.js (loads first on every page).
  const REPLAY_SECONDS = 60; // one sub-tick per real second of the 1-min bar

  function genSecondTicks(bar, prevClose, seed, avgVolume) {
    const n = REPLAY_SECONDS;
    const rng = seededRng(seed);
    const o = bar.o, h = bar.h, l = bar.l, c = bar.c;
    const start = Number.isFinite(prevClose) ? prevClose : o;
    const highFirst = rng() < 0.5;
    const range = Math.max(h - l, 0.0001);

    // Fixed OHLC anchors, same as before...
    const anchors = [
      { t: 0, p: start },
      { t: Math.round(n * 0.1), p: o },
      { t: Math.round(n * 0.42), p: highFirst ? h : l },
      { t: Math.round(n * 0.74), p: highFirst ? l : h },
      { t: n - 1, p: c },
    ];
    // ...plus one randomized midpoint inserted between each consecutive
    // pair, so there are ~8 waypoints instead of 5. Clamped to the
    // bar's own high/low so it never wanders outside the real range.
    const waypoints = [];
    for (let i = 0; i < anchors.length; i++) {
      waypoints.push(anchors[i]);
      if (i < anchors.length - 1) {
        const a = anchors[i], b = anchors[i + 1];
        const midT = Math.round((a.t + b.t) / 2);
        if (midT > a.t && midT < b.t) {
          const midP = (a.p + b.p) / 2 + (rng() - 0.5) * range * 0.25;
          waypoints.push({ t: midT, p: Math.min(h, Math.max(l, midP)) });
        }
      }
    }

    // Volume-relative jitter: this bar's volume vs. the session average,
    // clamped to [0.5x, 2x] so one outlier bar can't blow the path out
    // in either direction.
    const relVol = avgVolume > 0 ? Math.min(2, Math.max(0.5, (bar.v || 0) / avgVolume)) : 1;
    const jitterAmp = range * 0.07 * relVol;

    const ticks = [];
    let noise = 0; // smoothed, not redrawn independently every tick
    for (let s = 0; s < n; s++) {
      let a = waypoints[0], b = waypoints[waypoints.length - 1];
      for (let i = 0; i < waypoints.length - 1; i++) {
        if (s >= waypoints[i].t && s <= waypoints[i + 1].t) { a = waypoints[i]; b = waypoints[i + 1]; break; }
      }
      const span = Math.max(1, b.t - a.t);
      const frac = (s - a.t) / span;
      let price = a.p + (b.p - a.p) * frac;
      // Exponential smoothing: each tick nudges the running noise value
      // toward a fresh random draw instead of replacing it outright, so
      // the path drifts continuously rather than vibrating randomly.
      noise = noise * 0.7 + (rng() - 0.5) * 2 * jitterAmp * 0.3;
      price += noise;
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
  // Per-account scoping for /backtest/history* -- see backtester.js's
  // authedHeaders for the full rationale. Not used by fetchRealTicks below
  // (that's /generate-chart, which carries no per-user data).
  function authedChartServiceHeaders(extra) {
    return window.AUTH_READY.then((session) => {
      if (!session) throw new Error("Please log in first.");
      return Object.assign({}, CHART_SERVICE_FETCH_HEADERS, extra || {}, { "Authorization": "Bearer " + session.access_token });
    });
  }
  // chartServiceBase() now in utils.js (loads first on every page).
  // "Show full day" on the post-answer reveal chart -- pulls the rest of
  // that symbol's session from chart_service.py's /full-day-bars route,
  // same route/cache trade.js's "Full day" button uses. Only ever fired
  // by that button click (after a question's already been answered), so
  // it never affects the watch-stage playback pacing, which stays on
  // c.bars/c.entryIdx/c.watchIdx exactly as before.
  // FULL_DAY_CACHE_PREFIX/fetchFullDayBars() now in utils.js (loads first
  // on every page).

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

  // ---------------------------------------------------------------
  // Blind backtester mode — practice generation instead of replay.
  //
  // Reuses the SAME saved-run machinery backtester.html / report.html
  // already talk to (GET /backtest/history and GET
  // /backtest/history/<id>/report on chart_service.py) rather than
  // inventing a new backend endpoint. A run's trades only carry `bars`
  // once they've been through the existing "Send to Journal" enrichment
  // step on the Backtester tab (chart_service.py's /enrich callback) --
  // trades without bars can't be charted here, so they're filtered out
  // up front and the setup screen tells you how many were usable.
  // ---------------------------------------------------------------

  function loadBacktestRuns() {
    const base = chartServiceBase();
    if (!base) {
      els.btRunSelect.innerHTML = `<option value="">Set CHART_SERVICE_URL in config.js first</option>`;
      els.btRunSelect.disabled = true;
      return;
    }
    els.btRunSelect.disabled = false;
    authedChartServiceHeaders()
      .then((headers) => fetch(`${base}/backtest/history`, { headers }))
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((entries) => {
        state.backtestRuns = Array.isArray(entries) ? entries : [];
        if (!state.backtestRuns.length) {
          els.btRunSelect.innerHTML = `<option value="">No saved runs yet — run one on the Backtester tab first</option>`;
          els.btRunSelect.disabled = true;
          return;
        }
        els.btRunSelect.innerHTML = `<option value="">Choose a run…</option>` + state.backtestRuns.map((e) => {
          const s = e.stats || {};
          const label = `${e.label || "(untitled run)"} — ${s.num_trades || 0} trades, ${s.win_rate != null ? s.win_rate.toFixed(0) + "%" : "—"} win`;
          return `<option value="${escapeHtml(e.id)}">${escapeHtml(label)}</option>`;
        }).join("");
      })
      .catch(() => {
        els.btRunSelect.innerHTML = `<option value="">Couldn't reach chart_service.py</option>`;
        els.btRunSelect.disabled = true;
      });
  }

  // Backend `/backtest/history/<id>/report` trades carry `date` (not
  // `trade_date`), a flat `better_entry_price`/`better_exit_price` (no
  // time -- see report.js's same normalization note), and no
  // side/lessons/walk_away_rule at all (the strategy is long-only and
  // never gets the full daily-pipeline verdict treatment, just whatever
  // the optional /enrich step attached). Map it onto the same shape
  // initQuestion()/goToReveal() already read from a real journal
  // trade.detail file, leaving the fields that don't exist for a
  // backtest trade out entirely rather than faking them -- reveal
  // already renders every one of those as an optional section.
  function normalizeBacktestTrade(t, run) {
    const runLabel = (run && run.label) || "backtest run";
    const setupType = (run && run.params && run.params.entry_mode) || runLabel;
    const id = `bt:${(run && run.id) || runLabel}:${t.symbol}:${t.date}:${t.entry_time}`.replace(/\s+/g, "_");
    return {
      id,
      _source: "backtest",
      _runLabel: runLabel,
      symbol: t.symbol,
      side: "long", // the backtester only ever simulates long breakout entries
      trade_date: t.date,
      entry_time: t.entry_time,
      exit_time: t.exit_time,
      entry_price: t.entry_price,
      exit_price: t.exit_price,
      shares: t.shares,
      win: !!t.win,
      pnl_before_comm: Number.isFinite(Number(t.pnl_dollars_gross)) ? Number(t.pnl_dollars_gross) : undefined,
      commission: Number.isFinite(Number(t.commission_total)) ? Number(t.commission_total) : undefined,
      pnl_after_comm: t.pnl_dollars,
      setup_type: setupType,
      bars: t.bars,
      verdict: t.verdict || null,
      lessons: [],
      better_entry_price: t.better_entry_price != null ? Number(t.better_entry_price) : null,
      better_exit_price: t.better_exit_price != null ? Number(t.better_exit_price) : null,
      walk_away_rule: null,
      _exitReason: t.exit_reason || null,
      _rMultiple: Number.isFinite(Number(t.r_multiple)) ? Number(t.r_multiple) : null,
    };
  }

  function loadBacktestRunTrades(runId) {
    state.backtestRunId = runId;
    state.backtestTrades = [];
    if (!runId) { renderCandidateCount(); return; }
    const base = chartServiceBase();
    els.btHint.classList.remove("hidden"); els.btHint.style.display = "";
    els.btHint.innerHTML = "Loading this run's trades…";
    els.startBtn.disabled = true;

    const cached = state.backtestReportCache[runId];
    const p = cached ? Promise.resolve(cached) : authedChartServiceHeaders()
      .then((headers) => fetch(`${base}/backtest/history/${encodeURIComponent(runId)}/report`, { headers }))
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((data) => { state.backtestReportCache[runId] = data; return data; });

    p.then((report) => {
      const run = state.backtestRuns.find((e) => e.id === runId) || { id: runId, label: report.label, params: report.params };
      const all = Array.isArray(report.trades) ? report.trades : [];
      const withCharts = all.filter((t) => Array.isArray(t.bars) && t.bars.length);
      state.backtestTrades = withCharts.map((t) => normalizeBacktestTrade(t, run));
      const missing = all.length - withCharts.length;
      els.btHint.innerHTML = withCharts.length
        ? `<b>${withCharts.length}</b> of ${all.length} trades in this run have charts available for practice.` +
          (missing ? ` ${missing} more haven't been sent through journal enrichment yet — use the Backtester tab's "Send to Journal" to add charts to them.` : "")
        : `None of this run's ${all.length} trade${all.length === 1 ? "" : "s"} have charts yet — go to the Backtester tab, open this run, and use "Send to Journal" to enrich it before practicing on it.`;
      renderCandidateCount();
    }).catch((err) => {
      els.btHint.innerHTML = `Couldn't load this run's trades (${escapeHtml(String(err.message))}).`;
      els.startBtn.disabled = true;
    });
  }

  function setSource(src) {
    state.source = src === "backtest" ? "backtest" : "log";
    els.sourceRow.querySelectorAll(".quiz-mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.source === state.source));
    els.sourceHint.classList.remove("hidden"); els.sourceHint.style.display = state.source === "backtest" ? "" : "none";
    els.logFields.style.display = state.source === "backtest" ? "none" : "";
    els.btFields.classList.remove("hidden"); els.btFields.style.display = state.source === "backtest" ? "" : "none";
    if (els.includeReviewedCheck) {
      const row = document.getElementById("qf-include-reviewed-row");
      if (row) row.style.display = state.source === "backtest" ? "none" : "";
    }
    if (state.source === "backtest") {
      if (!state.backtestRuns.length) loadBacktestRuns();
      loadBacktestRunTrades(els.btRunSelect.value || null);
    } else {
      renderCandidateCount();
    }
  }
  els.sourceRow.querySelectorAll(".quiz-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => setSource(btn.dataset.source));
  });
  els.btRunSelect.addEventListener("change", () => loadBacktestRunTrades(els.btRunSelect.value || null));

  // Ticks for the checkpoint (mid-trade) bar — the full 60s window.
  function getCheckpointTicks(trade, bar, prevClose, avgVolume) {
    const simPrices = () => genSecondTicks(bar, prevClose, `${trade.id}:checkpoint`, avgVolume);
    if (state.tickMode !== "real") return Promise.resolve({ prices: simPrices(), real: false, fellBack: false });
    const start = toUnix(bar.t);
    return fetchRealTicks(trade.symbol, start, start + BAR_SECONDS).then((real) => (
      real ? { prices: real.map((t) => t.price), real: true, fellBack: false }
           : { prices: simPrices(), real: false, fellBack: true }
    ));
  }

  // The entry bar's full simulated path -- a pure function of the trade
  // (same seed every time), so the pre-entry tape and whatever's left of
  // the bar after you enter are always the SAME underlying walk, just
  // sliced at different points. That's what makes the post-entry
  // continuation (getEntryBarRemainderTicks below) pick up exactly where
  // the pre-entry tape (getEntryWatchTicks) left off instead of jumping
  // to an unrelated path.
  function simEntryBarTicks(trade, bar, prevClose, avgVolume) {
    return genSecondTicks(bar, prevClose, `${trade.id}:entrywatch`, avgVolume);
  }
  // How many ticks (1..REPLAY_SECONDS) are visible/elapsed by a given
  // point into the bar -- shared by the pre-entry tape's cutoff and the
  // default (un-watched) entry's implied tick index, so both agree on
  // exactly which tick your fill happened on.
  function entryTickCount(secondsIntoBar) {
    const frac = Math.max(0, Math.min(1, secondsIntoBar / BAR_SECONDS));
    return Math.max(1, Math.round(frac * REPLAY_SECONDS));
  }

  // Extra ticks of tape kept running past the real fill instant. Without
  // this the entry tape stopped dead exactly on your real entry price
  // every single time, so there was never a chance to see whether you'd
  // still want in a little later than you actually got in -- only
  // "enter right here" or "pass". Capped by REPLAY_SECONDS below.
  const ENTRY_EXTRA_SECONDS = 15;

  // Ticks for the "watch it print in" replay on the entry stage -- the
  // window from the bar's open up to a bit past the actual fill instant
  // (ENTRY_EXTRA_SECONDS), so you can still choose to enter on a later
  // tick than your real fill to see if you'd have taken it anyway.
  function getEntryWatchTicks(trade, bar, prevClose, secondsIntoBar, avgVolume) {
    const cut = entryTickCount(secondsIntoBar);
    const revealCount = Math.min(REPLAY_SECONDS, cut + ENTRY_EXTRA_SECONDS);
    const simPrices = () => {
      const full = simEntryBarTicks(trade, bar, prevClose, avgVolume);
      const t = full.slice(0, revealCount);
      t[cut - 1] = trade.entry_price; // anchor the real-fill tick, not just the tape's end
      return t;
    };
    if (state.tickMode !== "real") return Promise.resolve({ prices: simPrices(), real: false, fellBack: false });
    const start = toUnix(bar.t);
    const end = Math.min(start + BAR_SECONDS, Math.max(start + 1, start + revealCount));
    return fetchRealTicks(trade.symbol, start, end).then((real) => (
      real ? { prices: real.map((t) => t.price), real: true, fellBack: false }
           : { prices: simPrices(), real: false, fellBack: true }
    ));
  }

  // Continues the SAME entry bar's tape from the tick you actually
  // entered on through to the bar's close -- this is what used to be
  // skipped entirely (the watch stage jumped straight to the *next*
  // bar), cutting off however much of the entry candle was still left
  // to play. entryTickIdx is 0-based into the REPLAY_SECONDS space (the
  // same index space getEntryWatchTicks/onAct use), so slicing the same
  // deterministic path one tick past it picks up exactly where your
  // fill happened, with no jump. anchorPrice is whatever price you
  // actually entered at -- since the entry tape now keeps running past
  // the real fill instant, that might not be trade.entry_price anymore.
  function getEntryBarRemainderTicks(trade, bar, prevClose, entryTickIdx, avgVolume, anchorPrice) {
    const simPrices = () => {
      const full = simEntryBarTicks(trade, bar, prevClose, avgVolume);
      full[entryTickIdx] = Number.isFinite(anchorPrice) ? anchorPrice : trade.entry_price; // anchor to your actual fill so there's no seam
      return full.slice(entryTickIdx + 1);
    };
    if (state.tickMode !== "real") return Promise.resolve({ prices: simPrices(), real: false, fellBack: false });
    const barStart = toUnix(bar.t);
    const start = barStart + entryTickIdx + 1;
    const end = barStart + BAR_SECONDS;
    if (end <= start) return Promise.resolve({ prices: [], real: false, fellBack: false });
    return fetchRealTicks(trade.symbol, start, end).then((real) => (
      real ? { prices: real.map((t) => t.price), real: true, fellBack: false }
           : { prices: simPrices(), real: false, fellBack: true }
    ));
  }

  // Speed choices for the tick playback -- 1x is real time (one tick per
  // real second), so a full 1-min bar takes 60 real seconds unless you
  // speed it up.
  const REPLAY_SPEEDS = [1, 2, 4, 8, 20];
  function fmtClock(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  // Auto-plays through `ticks` at real-time pace by default (one tick per
  // real second at 1x -- a synthesized bar's 60 ticks take 60 real seconds
  // unless sped up), updating a live price readout. `actions` is a list of
  // {id, label, kbd, cls} buttons that are clickable at any point during
  // playback; clicking one locks in the current tick's price and stops
  // playback. If nobody clicks before the ticks run out, `opts.onExhausted`
  // runs if given, else `defaultActionId` fires automatically. A speed
  // picker (1x-20x) is rendered in the panel; changing it mid-playback just
  // changes the pace of ticks still to come, it never skips any. Returns
  // { stop } to let a caller tear it down early (e.g. the quiz question
  // changes underneath it).
  function runSecondReplay(container, ticks, opts) {
    const baseTickMs = opts.tickMs || 1000; // 1 tick = 1 real second at 1x
    const unitLabel = opts.unitLabel || "second";
    const tag = opts.tag || "simulated seconds";
    const tagCls = opts.tagCls ? ` ${opts.tagCls}` : "";
    // hideProgress drops the sweeping loading-style track + the "X elapsed /
    // Y left" line from this panel entirely -- used once you're actually in
    // a trade, where opts.liveClockEl (a header element) carries that same
    // elapsed/remaining info instead, framed as a live ticking clock rather
    // than a bar that looks like something is still loading.
    const hideProgress = !!opts.hideProgress;
    container.innerHTML = `
      <div class="quiz-replay-panel">
        <div class="quiz-replay-top">
          <button type="button" class="quiz-speed-btn quiz-pause-btn" id="qz-replay-pause">&#10074;&#10074; Pause</button>
          <div class="quiz-speed-row" id="qz-replay-speeds">
            ${REPLAY_SPEEDS.map((sp) => `<button type="button" class="quiz-speed-btn${sp === state.playbackSpeed ? " active" : ""}" data-speed="${sp}">${sp}&times;</button>`).join("")}
          </div>
          <span class="quiz-replay-tag${tagCls}">${escapeHtml(tag)}</span>
        </div>
        ${opts.fallbackNote ? `<div class="quiz-replay-fallback">${escapeHtml(opts.fallbackNote)}</div>` : ""}
        ${hideProgress ? "" : `<div class="quiz-replay-track"><div class="quiz-replay-bar" id="qz-replay-fill"></div></div>`}
        <div class="quiz-replay-row" id="qz-replay-actions"></div>
        ${hideProgress ? "" : `<div class="quiz-replay-sec" id="qz-replay-sec" style="margin-top:8px;"></div>`}
      </div>
    `;
    const pauseBtn = container.querySelector("#qz-replay-pause");
    const fillEl = container.querySelector("#qz-replay-fill");
    const secEl = container.querySelector("#qz-replay-sec");
    const actionsEl = container.querySelector("#qz-replay-actions");
    const speedsEl = container.querySelector("#qz-replay-speeds");
    const liveClockEl = opts.liveClockEl || null;
    (opts.actions || []).forEach((a) => {
      const btn = document.createElement("button");
      btn.id = `qz-${a.id}`;
      btn.className = `quiz-answer-btn ${a.cls || ""}`;
      btn.innerHTML = `${escapeHtml(a.label)}${a.kbd ? ` <span class="kbd">${escapeHtml(a.kbd)}</span>` : ""}`;
      btn.addEventListener("click", () => finish(a.id));
      actionsEl.appendChild(btn);
    });
    speedsEl.querySelectorAll(".quiz-speed-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.playbackSpeed = Number(btn.dataset.speed) || 1;
        speedsEl.querySelectorAll(".quiz-speed-btn").forEach((b) => b.classList.toggle("active", b === btn));
        // Re-arm the wait with the new pace right away instead of letting
        // the slower/faster old delay run out first. Skipped while paused
        // -- resuming (not the speed click) is what should restart ticks.
        if (!done && !paused) { clearTimeout(timer); scheduleNext(); }
      });
    });
    // Pause just stops the timer from re-arming -- the tape holds exactly
    // where it is (last painted candle/price stays on screen) so you can
    // stop and think without losing your place. Action buttons (Enter,
    // Exit, etc.) stay live while paused, since deciding is the point.
    let paused = false;
    pauseBtn.addEventListener("click", () => {
      if (done) return;
      paused = !paused;
      pauseBtn.innerHTML = paused ? "&#9654; Resume" : "&#10074;&#10074; Pause";
      pauseBtn.classList.toggle("active", paused);
      if (paused) clearTimeout(timer);
      else scheduleNext();
    });

    // If given a live chart + the raw bar being replayed, push a real
    // forming candle that grows/wicks with each tick instead of just
    // updating the text readout -- same forming-candle look/colors the
    // entry stage uses for its own partial bar.
    const liveChart = opts.chartHandle && opts.bar ? opts.chartHandle : null;
    const barTime = liveChart ? toUnix(opts.bar.t) : null;
    // seedHigh/seedLow let a caller continue a candle that already has a
    // body (e.g. resuming the entry bar right after your fill) instead of
    // always resetting the wick back down to the bar's open -- without
    // them this defaults to the old flat-at-open start.
    let runningHigh = liveChart ? (opts.seedHigh != null ? opts.seedHigh : opts.bar.o) : null;
    let runningLow = liveChart ? (opts.seedLow != null ? opts.seedLow : opts.bar.o) : null;
    // volStartFrac lets volume continue accumulating from where an
    // earlier segment of the same bar left off, instead of restarting
    // the fraction from 0 for a partial tick set.
    const volStartFrac = opts.volStartFrac || 0;
    function paintCandle(idx) {
      if (!liveChart) return;
      const price = ticks[idx];
      if (price > runningHigh) runningHigh = price;
      if (price < runningLow) runningLow = price;
      liveChart.series.update({
        time: barTime, open: opts.bar.o, high: runningHigh, low: runningLow, close: price,
        color: "rgba(232,169,76,0.55)", borderColor: "#e8a94c", wickColor: "#e8a94c",
      });
      if (liveChart.volSeries) {
        const localFrac = (idx + 1) / ticks.length;
        const frac = volStartFrac + localFrac * (1 - volStartFrac);
        const formingVol = Math.round((opts.bar.v || 0) * frac);
        liveChart.volSeries.update({ time: barTime, value: formingVol, color: "rgba(232,169,76,0.4)" });
        if (liveChart.handleState) {
          liveChart.handleState.lastVol = formingVol;
          liveChart.handleState.lastVwap = opts.bar.vwap;
          liveChart.handleState.lastEma9 = opts.bar.ema9;
          liveChart.handleState.lastEma20 = opts.bar.ema20;
          liveChart.handleState.lastEma200 = opts.bar.ema200;
          if (liveChart.renderOverlay) liveChart.renderOverlay(formingVol, "", opts.bar.vwap, opts.bar.ema9, opts.bar.ema20, opts.bar.ema200);
        }
      }
    }
    if (liveChart) {
      // Seed a zero-range candle before ticking so there's room for it on
      // the timescale, then make sure that room is actually visible.
      paintCandle(0);
      // Only snap/fit the visible range on demand (opts.autoFit === false
      // skips it) -- doing this on every bar of a multi-bar watch session
      // would yank the chart back to a full-fit view each time and wipe
      // out any zoom/pan the moment a new candle starts.
      if (opts.autoFit !== false) {
        try { liveChart.chart.timeScale().fitContent(); } catch (e) {}
      }
    }

    let i = 0, done = false, timer = null;
    // Each tick is a real second (divided by the speed picker) -- no
    // stretching. A previous version inflated the per-tick delay when
    // there were only a few ticks left (so a short tape would still take
    // some minimum total time), but that made "1 second" actually take
    // several real seconds, which is the opposite of real-time.
    function currentTickMs() { return Math.max(20, Math.round(baseTickMs / (state.playbackSpeed || 1))); }
    function paint() {
      if (unitLabel === "second") {
        // Real-time framing: how far into the candle we are and how much
        // is left, so it's obvious when the candle is about to close.
        const elapsed = i + 1, remaining = ticks.length - elapsed;
        if (secEl) secEl.textContent = `${fmtClock(elapsed)} elapsed \u00b7 ${fmtClock(remaining)} left on this candle`;
        // Same elapsed/remaining info, but ticking live up in the header
        // like an actual trading clock instead of a bar sweeping across a
        // panel -- this is what a live position should feel like.
        if (liveClockEl) {
          liveClockEl.innerHTML = `<span class="quiz-live-dot"></span>${fmtClock(elapsed)} <span class="dim" style="font-weight:400;">of ${fmtClock(ticks.length)} on this candle</span>`;
        }
      } else {
        // Real server ticks aren't evenly spaced in time, so a plain
        // count is more honest than a clock here.
        if (secEl) secEl.textContent = `${unitLabel} ${i + 1} of ${ticks.length}`;
        if (liveClockEl) liveClockEl.innerHTML = `<span class="quiz-live-dot"></span>${unitLabel} ${i + 1} of ${ticks.length}`;
      }
      if (fillEl) fillEl.style.width = `${((i + 1) / ticks.length) * 100}%`;
      paintCandle(i);
    }
    function finish(actionId) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
      pauseBtn.disabled = true;
      opts.onAct && opts.onAct(actionId, i, ticks[i]);
    }
    // Lets a caller watch every printed tick without waiting for the replay
    // to finish -- used to auto-trigger a stop-loss the instant price
    // crosses it, same as it would in a real fill.
    function checkTick() { if (opts.onTick) opts.onTick(ticks[i], i); }
    function scheduleNext() { timer = setTimeout(advance, currentTickMs()); }
    function advance() {
      if (done) return;
      if (i >= ticks.length - 1) {
        // onExhausted lets a caller move on (e.g. to the next bar) instead
        // of forcing a default action once the tape runs out -- falls back
        // to the old auto-fire-defaultActionId behavior when not given.
        if (opts.onExhausted) { done = true; actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true)); pauseBtn.disabled = true; opts.onExhausted(); }
        else finish(opts.defaultActionId);
        return;
      }
      i++;
      paint();
      checkTick();
      scheduleNext();
    }
    paint();
    checkTick();
    scheduleNext();
    return {
      stop: () => { done = true; clearTimeout(timer); },
      // Lets a caller outside this closure (e.g. a persistent partial-exit
      // button row that isn't rebuilt every tick) read the price/index of
      // whatever tick is currently on screen at the moment it's clicked.
      getPrice: () => ticks[i],
      getIndex: () => i,
    };
  }
  Object.assign(R, { REPLAY_SECONDS, entryTickCount, fmtClock, getCheckpointTicks, getEntryBarRemainderTicks, getEntryWatchTicks, normalizeBacktestTrade, runSecondReplay });
})();
