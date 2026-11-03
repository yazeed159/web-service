(function () {
  "use strict";
  const R = (window.RewindKit = window.RewindKit || {});
  const { BAR_SECONDS, SIZE_BASELINE, barIndexAt, els, shuffle, state } = R;
  const finishQuiz = (...args) => R.finishQuiz(...args);
  const renderEntryStage = (...args) => R.renderEntryStage(...args);

  // ---------------------------------------------------------------
  // quiz flow
  // ---------------------------------------------------------------
  function startQuiz(filters, ids) {
    state.queue = shuffle(ids).slice(0, filters.count > 0 ? filters.count : ids.length);
    state.qIndex = 0;
    state.blind = filters.blind;
    state.tickMode = filters.tickMode === "real" ? "real" : "sim";
    state.results = [];
    state.recordedIds = new Set();
    els.setupScreen.style.display = "none";
    els.summaryScreen.classList.remove("hidden"); els.summaryScreen.style.display = "none";
    els.playScreen.style.display = "";
    loadQuestion();
  }

  function fetchDetail(id) {
    if (state.detailCache[id]) return Promise.resolve(state.detailCache[id]);
    // Backtest-sourced trades are always pre-seeded into detailCache
    // before the queue is built (see the start-button handler above) --
    // there's no data/trades/<id>.json to fall back to for a synthetic
    // "bt:..." id, so a cache miss here means something's wrong rather
    // than something to fetch.
    if (state.source === "backtest") return Promise.reject(new Error("This practice setup is no longer available."));
    return window.fetchTradeDetail(id)
      .then((trade) => { state.detailCache[id] = trade; return trade; });
  }

  function updateHeaderChrome() {
    els.progressLabel.textContent = `Trade ${Math.min(state.qIndex + 1, state.queue.length)} / ${state.queue.length}`;
    els.progressFill.style.width = `${(state.qIndex / state.queue.length) * 100}%`;
  }

  // Anything past the initial fetch runs inside click handlers, setInterval
  // ticks, or promise callbacks that a plain try/catch around the initial
  // fetch can't see -- a thrown error there is normally swallowed silently
  // by the browser, leaving whatever was on screen (often mid-action, with
  // its buttons already disabled) permanently stuck with nothing to click.
  // Every risky entry point below is wrapped so a failure instead lands
  // here: a clear message plus a way to move on.
  function showStageError(err) {
    if (state.current && state.current.replayHandle) { state.current.replayHandle.stop(); state.current.replayHandle = null; }
    els.card.innerHTML = `<div class="empty-state">Something went wrong showing this trade (${escapeHtml(String((err && err.message) || err))}). <button class="btn-advanced" id="qz-skip">Skip this setup</button></div>`;
    const skip = document.getElementById("qz-skip");
    if (skip) skip.addEventListener("click", () => { state.qIndex++; loadQuestion(); });
  }

  function loadQuestion() {
    if (state.current && state.current.replayHandle) state.current.replayHandle.stop();
    updateHeaderChrome();
    if (state.qIndex >= state.queue.length) { finishQuiz(); return; }
    els.card.innerHTML = `<div class="loading-line">Loading chart…</div>`;
    fetchDetail(state.queue[state.qIndex])
      .then((trade) => initQuestion(trade))
      .catch(showStageError);
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
      // Session-average bar volume, used to scale how choppy the simulated
      // tick path looks per-bar (see genSecondTicks) -- computed once here
      // instead of per-bar so a single outlier bar can't skew its own
      // baseline.
      avgVolume: bars.length ? bars.reduce((s, b) => s + (b.v || 0), 0) / bars.length : 0,
      stage: "entry",
      entered: null,
      userEntryPrice: null,
      stopPrice: null,
      stoppedOutEarly: false, // set true the instant a live tick crosses your stop, whenever that happens
      stopOutIdx: null, // bar index the stop got hit in
      entrySecondsIntoBar: null, // how far into the entry bar the real fill happened
      entryBarPrevClose: null, // prior bar's close, feeds the entry bar's deterministic sim path
      entryTickIdx: null, // which tick (0..REPLAY_SECONDS-1) you actually entered on
      watchIdx: null, // bar currently playing in the post-entry watch stage
      checkpointAction: null, // "exit" once you click Exit; stays null if you watch through to the end of the data
      exitBarIdx: null, // bar index your last (fully-flattening) exit tick fell in
      chartHandle: null,
      replayHandle: null,
      userExitPrice: null,
      exitSecond: null,
      userShares: SIZE_BASELINE, // your INITIAL size, chosen in the stop stage -- stays fixed afterward; only feeds the sizing-conviction grade
      // Full position history, in share units. `buys` starts with your
      // initial fill (tag "entry") and gets one more entry per "Add to
      // position" click (tag "add"). `exits` gets one entry per closed
      // tranche -- tag "sell" (you clicked Sell), "stop" (your stop got
      // hit), or "held" (whatever was still open when the data ran out,
      // synthesized at reveal time). openShares is how much of the
      // position is open right now; avgCost is the running average-cost
      // basis of that open size -- only buys move it, selling never
      // changes the cost of whatever's left.
      buys: [],
      exits: [],
      openShares: 0,
      avgCost: null,
      moveStopArmed: false, // true while "Move stop" is armed and the next chart click should relocate the stop
    };
    renderEntryStage();
  }

  // Puts the current question back exactly the way it looked when it first
  // loaded — same trade, back to the entry decision — so you can have
  // another go without leaving the quiz or affecting your queue position.
  function retryCurrentQuestion() {
    const c = state.current;
    if (!c) return;
    if (c.replayHandle) { c.replayHandle.stop(); c.replayHandle = null; }
    initQuestion(c.trade);
  }

  function displayLabel(trade) {
    return state.blind
      ? { name: `Setup #${state.qIndex + 1}`, date: "" }
      : { name: trade.symbol, date: trade.trade_date };
  }

  // The bar the entry fill happened inside is only *partially* known at
  // decision time, and that includes the fill price itself: the whole
  // point of "Watch it print in" is to find out where price actually
  // goes, so the chart you see before you've decided (or before you've
  // pressed watch) can't already show a candle reaching the real fill --
  // that would spoil the tape before it plays. So the default view is
  // just a flat, just-opened candle with no body yet. The entry prompt
  // still states the current price in text (you need that to decide),
  // but the chart's shape is only revealed once you've watched it print
  // or made your call -- see pushFormingBarPrice below.
  function buildFormingBar(fullBar) {
    return {
      t: fullBar.t, o: fullBar.o, h: fullBar.o, l: fullBar.o, c: fullBar.o, v: 0,
      vwap: fullBar.vwap, ema9: fullBar.ema9, ema20: fullBar.ema20, ema200: fullBar.ema200,
      _forming: true,
    };
  }
  // Reveals the forming candle's body up to a given price, clamped so it
  // still never leaks the bar's real (future-relative-to-this-point)
  // extremes -- same clamp buildFormingBar used to apply up front. Used
  // once you've actually entered (or watched the tape) without a live
  // replay already having painted it tick by tick.
  function pushFormingBarPrice(chartHandle, bar, price, secondsIntoBar) {
    if (!chartHandle) return;
    const frac = Math.max(0, Math.min(1, secondsIntoBar / BAR_SECONDS));
    try {
      chartHandle.series.update({
        time: toUnix(bar.t), open: bar.o, high: Math.max(bar.o, price), low: Math.min(bar.o, price), close: price,
        color: "rgba(232,169,76,0.55)", borderColor: "#e8a94c", wickColor: "#e8a94c",
      });
      if (chartHandle.volSeries) {
        const formingVol = Math.round((bar.v || 0) * frac);
        chartHandle.volSeries.update({ time: toUnix(bar.t), value: formingVol, color: "rgba(232,169,76,0.4)" });
        if (chartHandle.handleState) {
          chartHandle.handleState.lastVol = formingVol;
          chartHandle.handleState.lastVwap = bar.vwap;
          chartHandle.handleState.lastEma9 = bar.ema9;
          chartHandle.handleState.lastEma20 = bar.ema20;
          chartHandle.handleState.lastEma200 = bar.ema200;
          if (chartHandle.renderOverlay) chartHandle.renderOverlay(formingVol, "", bar.vwap, bar.ema9, bar.ema20, bar.ema200);
        }
      }
    } catch (e) { /* chart already torn down */ }
  }
  Object.assign(R, { buildFormingBar, displayLabel, loadQuestion, pushFormingBarPrice, retryCurrentQuestion, showStageError, startQuiz });
})();
