(function () {
  "use strict";
  const R = (window.RewindKit = window.RewindKit || {});
  const { COLOR_REAL_ENTRY, COLOR_REAL_EXIT, COLOR_STOP_EVENT, COLOR_YOUR_ENTRY, COLOR_YOUR_EXIT, COLOR_YOUR_STOP, attachPointers, buildChart, computeGrading, els, fmtSignedPerShare, getCandidateRows, getFilters, loadQuestion, markReviewed, recordExit, renderCandidateCount, renderHistoryPanel, renderProgressPanel, retryCurrentQuestion, saveHistoryEntry, setMoveStopBtnState, showStageError, startQuiz, state } = R;

  // ---------- Stage D: full reveal ----------
  function goToReveal() {
    const c = state.current;
    try {
    const trade = c.trade;
    // Top up whatever's still open with a synthetic "held to end" tranche
    // at the real exit price -- same as before when you never clicked
    // Exit at all, but now it also covers the leftover slice after a
    // partial scale-out where you never got around to closing the rest.
    if (c.entered && c.openShares > 1e-9) {
      recordExit(c, c.openShares, trade.exit_price, c.exitIdx, null, "held");
    }
    const grading = computeGrading(c);
    c.stage = "reveal";

    // Only the first pass through a given trade gets recorded in the recap —
    // hitting "Retry this question" lets you replay it for practice without
    // adding a second entry for the same trade.
    if (!state.recordedIds.has(trade.id)) {
      state.recordedIds.add(trade.id);
      // Log the trade as rewinded (skipped for backtest-generated
      // trades -- see REVIEWED_KEY above) so it's excluded from future
      // candidate pools until reset.
      if (trade._source !== "backtest") markReviewed(trade.id);
      state.results.push({
        id: trade.id, symbol: trade.symbol, setup_type: trade.setup_type, win: !!trade.win,
        source: trade._source === "backtest" ? "backtest" : "log",
        entered: c.entered, entryTone: grading.entryGrade.tone,
        stopTone: grading.stopGrade ? grading.stopGrade.tone : null,
        exitTone: grading.exitGrade ? grading.exitGrade.tone : null,
        sizeTone: grading.sizeGrade ? grading.sizeGrade.tone : null,
      });
    }

    const entryBar = c.bars[c.entryIdx], exitBar = c.bars[c.exitIdx];

    // The real entry/exit fills, your own stop (if you had one), and
    // whatever you actually did at exit time -- each gets both a
    // full-width price line (so the level is easy to read off the right
    // axis) and a pointer triangle sitting exactly on the fill (so the
    // exact bar/time is unambiguous too), same combination trade.html
    // uses. AI stop/target and better-entry/exit stay in the text panels
    // below rather than adding more lines to the chart.
    const pointerDefs = [
      { time: toUnix(entryBar.t), price: trade.entry_price, color: COLOR_REAL_ENTRY, above: true, tooltip: `REAL ENTRY $${fmtPrice(trade.entry_price)}` },
      { time: toUnix(exitBar.t), price: trade.exit_price, color: COLOR_REAL_EXIT, above: false, tooltip: `REAL EXIT $${fmtPrice(trade.exit_price)}` },
    ];
    if (c.entered && c.userEntryPrice != null) {
      pointerDefs.push({ time: toUnix(entryBar.t), price: c.userEntryPrice, color: COLOR_YOUR_ENTRY, above: true, tooltip: `TEST ENTRY $${fmtPrice(c.userEntryPrice)}` });
    }
    // One pointer per share you added mid-trade.
    c.buys.filter((b) => b.tag === "add").forEach((b) => {
      if (b.barIdx == null) return;
      const bar = c.bars[b.barIdx];
      if (!bar) return;
      pointerDefs.push({ time: toUnix(bar.t), price: b.price, color: COLOR_YOUR_ENTRY, above: true, tooltip: `ADDED ${b.shares} sh $${fmtPrice(b.price)}` });
    });
    // One pointer per tranche you actually closed yourself (sell or stop)
    // -- skips synthetic "held" tranches since that price just duplicates
    // the real-exit line already on the chart. A single clean exit reads
    // as "TEST EXIT" same as before; more than one gets labeled with the
    // share count so a scale-out is legible at a glance.
    const manualTranches = c.exits.filter((e) => e.tag !== "held");
    manualTranches.forEach((e) => {
      if (e.barIdx == null) return;
      const bar = c.bars[e.barIdx];
      if (!bar) return;
      const label = e.tag === "stop"
        ? (manualTranches.length > 1 ? `STOPPED OUT (${e.shares} sh) $${fmtPrice(e.price)}` : `STOPPED OUT $${fmtPrice(e.price)}`)
        : (manualTranches.length > 1 ? `SOLD ${e.shares} sh $${fmtPrice(e.price)}` : `TEST EXIT $${fmtPrice(e.price)}`);
      pointerDefs.push({ time: toUnix(bar.t), price: e.price, color: e.tag === "stop" ? COLOR_STOP_EVENT : COLOR_YOUR_EXIT, above: false, tooltip: label });
    });

    const priceLines = [
      { price: trade.entry_price, color: COLOR_REAL_ENTRY, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, lineVisible: true, axisLabelVisible: true, title: "real entry" },
      { price: trade.exit_price, color: COLOR_REAL_EXIT, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, lineVisible: true, axisLabelVisible: true, title: "real exit" },
    ];
    if (c.entered && c.userEntryPrice != null) {
      priceLines.push({ price: c.userEntryPrice, color: COLOR_YOUR_ENTRY, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, lineVisible: true, axisLabelVisible: true, title: "test entry" });
    }
    if (c.entered && c.stopPrice != null) {
      priceLines.push({ price: c.stopPrice, color: COLOR_YOUR_STOP, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, lineVisible: true, axisLabelVisible: true, title: "your stop" });
    }
    // Each closed tranche's price gets its own line too, not just a
    // pointer -- same treatment "your stop" already got -- so every fill
    // is readable off the right axis even without hovering. A stop
    // tranche is skipped here since that price already has a line via
    // "your stop".
    manualTranches.filter((e) => e.tag !== "stop").forEach((e) => {
      priceLines.push({
        price: e.price, color: COLOR_YOUR_EXIT, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, lineVisible: true, axisLabelVisible: true,
        title: manualTranches.length > 1 ? `exit ${e.shares} sh` : "test exit",
      });
    });

    const label = { name: trade.symbol, date: trade.trade_date }; // reveal always shows the real thing
    const winPillHtml = `<span class="pill ${trade.win ? "win" : "loss"}">${trade.win ? "Winner" : "Loser"}</span>`;

    function pillFor(tone) { return `pill ${tone === "good" ? "good" : tone === "bad" ? "bad" : tone === "warn" ? "warn" : "neutral"}`; }

    const entryFillNote = (c.entered && c.userEntryPrice != null)
      ? ` at <b>$${fmtPrice(c.userEntryPrice)}</b>${Math.abs(c.userEntryPrice - trade.entry_price) > 0.0001 ? ` <span class="dim">(real fill: $${fmtPrice(trade.entry_price)})</span>` : ""}`
      : "";
    const entryRowHtml = `<div class="rb-line">You: <b>${c.entered ? "Entered" : "Passed"}</b>${entryFillNote}</div>
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

    const totalSharesTraded = Number.isFinite(grading.userTotalShares) ? grading.userTotalShares : c.userShares;
    const sizeRowHtml = grading.sizeGrade
      ? `<div class="rb-line">You sized: <b>${c.userShares} sh</b>${totalSharesTraded !== c.userShares ? ` <span class="dim">(${totalSharesTraded} sh total after adding)</span>` : ""} <span class="dim">(actual trade: ${trade.shares} sh)</span></div>
         <div class="rb-line"><span class="${pillFor(grading.sizeGrade.tone)}">${escapeHtml(grading.sizeGrade.label)}</span></div>`
      : `<div class="rb-line dim">You passed, so no size to grade.</div>`;

    // "Real numbers" -- what your own size/entry/exit would've cost using
    // IBKR's real tiered commission schedule (per-share rate with a
    // per-order floor and ceiling), applied on BOTH sides of the
    // comparison. The dataset's logged trade.commission field is noisy
    // and doesn't track any consistent fee schedule -- e.g. two 50-share
    // trades in the same price range are logged at $0.02 and $2.01 -- so
    // trusting it verbatim for "actual" while computing "yours" from the
    // real schedule made the two sides incomparable (and made the real
    // trade look far cheaper than it would actually have cost). Instead,
    // recompute the actual trade's commission the same way, from its own
    // shares and entry/exit fill prices, so both numbers reflect the same
    // real-world schedule and differ only by what was actually traded.
    const tradeShares = Number(trade.shares) || 0;
    const tradeCommission = ibkrTieredCommission(tradeShares, trade.entry_price) + ibkrTieredCommission(tradeShares, trade.exit_price);
    const tradePnlBeforeComm = Number(trade.pnl_before_comm);
    const tradeNet = Number.isFinite(tradePnlBeforeComm) ? tradePnlBeforeComm - tradeCommission : Number(trade.pnl_after_comm) || 0;
    // Total dollar P&L across every tranche (not just the initial size),
    // already computed leg-by-leg against the running average cost in
    // computeGrading -- no need to re-derive it from a per-share average
    // here, which would silently break once size changed mid-trade.
    const userGross = c.entered && Number.isFinite(grading.userRealizedTotal) ? grading.userRealizedTotal : null;
    // Each buy and each sell is its own real order -- sum commission per
    // tranche (in actual share units now, so this is exact even after
    // adding to the position) instead of applying one rate to a single
    // blended price.
    const userEntryCommission = c.entered ? c.buys.reduce((s, b) => s + ibkrTieredCommission(b.shares, b.price), 0) : 0;
    const userExitCommission = c.entered ? c.exits.reduce((s, e) => s + ibkrTieredCommission(e.shares, e.price), 0) : 0;
    const userCommission = c.entered ? userEntryCommission + userExitCommission : null;
    const userNet = (userGross != null && userCommission != null) ? userGross - userCommission : null;

    function normalizeLesson(l) {
      if (typeof l !== "string") return l;
      try {
        const parsed = JSON.parse(l);
        return (parsed && typeof parsed === "object") ? parsed : l;
      } catch (e) { return l; /* genuinely plain text */ }
    }
    const lessonsHtml = (trade.lessons || []).map(normalizeLesson).map((l) => {
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
          <span class="pill" style="${window.setupTagStyleAttr(trade.setup_type || 'unlabeled setup')}">${escapeHtml((trade.setup_type || "unlabeled setup").replace(/_/g, " "))}</span>
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
          <div class="rb-line">Entry <b>$${fmtPrice(trade.entry_price)}</b> actual${c.entered && c.userEntryPrice != null ? ` · <b>$${fmtPrice(c.userEntryPrice)}</b> yours` : ""} at <b>${escapeHtml(trade.entry_time)}</b> → Exit <b>$${fmtPrice(trade.exit_price)}</b> at <b>${escapeHtml(trade.exit_time)}</b> <span class="dim">(${escapeHtml(trade.time_in_trade || "—")} in trade)</span></div>
          <div class="rb-line">Shares: <b>${tradeShares}</b> actual${c.entered ? ` · <b>${totalSharesTraded}</b> yours` : ""} &nbsp;·&nbsp; Commission: <b>$${tradeCommission.toFixed(2)}</b> actual${c.entered && userCommission != null ? ` · <b>$${userCommission.toFixed(2)}</b> yours` : ""}</div>
          <div class="rb-line">Net P&amp;L: <b style="color:${tradeNet >= 0 ? "var(--green)" : "var(--red)"}">${tradeNet >= 0 ? "+" : "-"}$${Math.abs(tradeNet).toFixed(2)}</b> actual${c.entered && userNet != null ? ` · <b style="color:${userNet >= 0 ? "var(--green)" : "var(--red)"}">${userNet >= 0 ? "+" : "-"}$${Math.abs(userNet).toFixed(2)}</b> yours` : ""}</div>
        </div>
      </div>

      ${trade.verdict ? `<div class="quiz-verdict-box"><span class="vb-label">What actually happened</span>${escapeHtml(trade.verdict)}</div>` : ""}
      ${lessonsHtml ? `<ul class="quiz-lesson-list">${lessonsHtml}</ul>` : ""}
      ${trade.walk_away_rule ? `<div class="quiz-walkaway"><b>Walk-away rule:</b> ${escapeHtml(trade.walk_away_rule)}</div>` : ""}

      <div class="quiz-next-row">
        <button class="btn-advanced" id="qz-replay-again-btn" type="button">↻ Retry this setup</button>
        <button class="btn-advanced" id="qz-full-day-btn" type="button" title="Load this symbol's whole session so you can zoom/pan out past the trade window">Show full day</button>
        ${trade._source === "backtest"
          ? `<span class="btn-advanced" style="opacity:.6; cursor:default;" title="Generated from a backtest run, not saved in your journal">Practice-generated setup</span>`
          : `<a class="btn-advanced" href="trade.html?id=${encodeURIComponent(trade.id)}" target="_blank" rel="noopener">Open full trade page</a>`}
        <button class="btn-confirm" id="qz-next">${isLast ? "See results" : "Next setup"} <span class="kbd">↵</span></button>
      </div>
    `;

    teardownChart(c.chartHandle);
    const chartEl = document.getElementById("quiz-candle-chart");
    c.chartHandle = buildChart(chartEl, c.bars, { height: 400, priceLines, showLastValueLine: false });
    attachPointers(chartEl, c.chartHandle, pointerDefs);

    document.getElementById("qz-replay-again-btn").addEventListener("click", () => retryCurrentQuestion());
    document.getElementById("qz-next").addEventListener("click", () => { state.qIndex++; loadQuestion(); });
    const fullDayBtn = document.getElementById("qz-full-day-btn");
    if (fullDayBtn) {
      fullDayBtn.addEventListener("click", () => {
        if (fullDayBtn.disabled) return;
        fullDayBtn.disabled = true;
        const original = fullDayBtn.textContent;
        fullDayBtn.textContent = "Loading…";
        fetchFullDayBars(trade.symbol, trade.trade_date)
          .then((fullBars) => {
            if (!fullBars.length) throw new Error("No bars came back");
            teardownChart(c.chartHandle);
            c.chartHandle = buildChart(chartEl, fullBars, { height: 400, priceLines, showLastValueLine: false });
            attachPointers(chartEl, c.chartHandle, pointerDefs);
            fullDayBtn.textContent = "Full day loaded";
          })
          .catch((err) => {
            fullDayBtn.textContent = original;
            fullDayBtn.disabled = false;
            fullDayBtn.title = "Couldn't load the full day: " + err.message;
          });
      });
    }
    } catch (err) { showStageError(err); }
  }

  // ---------------------------------------------------------------
  // keyboard shortcuts — ignored while typing in the stop input
  // ---------------------------------------------------------------
  window.PAGE_SHORTCUTS = {
    heading: "Rewind (during a trade)",
    items: [
      { keys: ["Y", "Enter"], label: "Entry stage: take the trade" },
      { keys: ["N", "Esc"], label: "Entry stage: pass" },
      { keys: ["E", "1"], label: "Watch stage: exit fully" },
      { keys: ["2"], label: "Watch stage: sell 25%" },
      { keys: ["3"], label: "Watch stage: sell 50%" },
      { keys: ["S"], label: "Watch stage: move stop" },
      { keys: ["A"], label: "Watch stage: add to position" },
      { keys: ["Enter"], label: "Stop stage: confirm" },
    ],
  };
  document.addEventListener("keydown", (e) => {
    if (els.playScreen.style.display === "none") return;
    const c = state.current;
    if (!c) return;
    const typing = document.activeElement && document.activeElement.tagName === "INPUT";
    if (c.stage === "entry" && !typing) {
      if (e.key === "y" || e.key === "Y" || e.key === "Enter") document.getElementById("qz-enter")?.click();
      if (e.key === "n" || e.key === "N" || e.key === "Escape") document.getElementById("qz-pass")?.click();
    } else if (c.stage === "watch" && !typing) {
      if (e.key === "e" || e.key === "E" || e.key === "1") document.getElementById("qz-exit")?.click();
      if (e.key === "2") document.querySelector('#qz-partial-row button[data-sell="0.25"]')?.click();
      if (e.key === "3") document.querySelector('#qz-partial-row button[data-sell="0.5"]')?.click();
      if (e.key === "s" || e.key === "S") document.getElementById("qz-move-stop-btn")?.click();
      if (e.key === "a" || e.key === "A") document.getElementById("qz-add-btn")?.click();
      if (e.key === "Escape" && c.moveStopArmed) { c.moveStopArmed = false; setMoveStopBtnState(); }
    } else if (c.stage === "stop" && e.key === "Enter") {
      // Enter locks in from either input too, not just a click on the
      // button -- the whole point of tightening this stage's layout was
      // to cut down on hunting for a button below the fold.
      e.preventDefault();
      document.getElementById("quiz-stop-confirm")?.click();
    } else if (c.stage === "reveal" && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      document.getElementById("qz-next")?.click();
    }
  });

  els.quitBtn.addEventListener("click", async () => {
    const ok = await UIModal.confirm("End this session? Progress on the current trade won't be saved.", { title: "End session?", tone: "danger", confirmLabel: "End session" });
    if (!ok) return;
    goToSetupScreen();
  });

  function goToSetupScreen() {
    if (state.current && state.current.chartHandle) teardownChart(state.current.chartHandle);
    if (state.current && state.current.replayHandle) state.current.replayHandle.stop();
    state.current = null;
    els.playScreen.style.display = "none";
    els.summaryScreen.classList.remove("hidden"); els.summaryScreen.style.display = "none";
    els.setupScreen.style.display = "";
    renderHistoryPanel();
    renderCandidateCount();
    renderProgressPanel();
  }

  // ---------------------------------------------------------------
  // session recap — deliberately no score, accuracy %, or streak.
  // Three clearly separated sections, top to bottom: what you did
  // (recap counts), how it read across the four kinds of call
  // (breakdown), then the trade-by-trade detail (review table).
  // ---------------------------------------------------------------
  function finishQuiz() {
    els.playScreen.style.display = "none";
    els.summaryScreen.classList.remove("hidden"); els.summaryScreen.style.display = "";

    const total = state.results.length;
    const entered = state.results.filter((r) => r.entered).length;
    const passed = total - entered;

    els.recap.innerHTML = `
      <div class="rewind-recap-stats">
        <div class="rewind-stat"><span class="rs-num">${total}</span><span class="rs-lbl">Setups reviewed</span></div>
        <div class="rewind-stat"><span class="rs-num">${entered}</span><span class="rs-lbl">Entered</span></div>
        <div class="rewind-stat"><span class="rs-num">${passed}</span><span class="rs-lbl">Passed</span></div>
      </div>
    `;

    function tally(field) {
      const t = { good: 0, warn: 0, bad: 0, neutral: 0 };
      state.results.forEach((r) => { if (r[field]) t[r[field]] = (t[r[field]] || 0) + 1; });
      return t;
    }
    const entryTally = tally("entryTone");
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
      <div class="quiz-breakdown-row"><span class="br-k">Entry read</span><span class="br-chips">${chipsHtml(entryTally)}</span></div>
      <div class="quiz-breakdown-row"><span class="br-k">Stop placement</span><span class="br-chips">${chipsHtml(stopTally)}</span></div>
      <div class="quiz-breakdown-row"><span class="br-k">Exit timing</span><span class="br-chips">${chipsHtml(exitTally)}</span></div>
      <div class="quiz-breakdown-row"><span class="br-k">Position sizing</span><span class="br-chips">${chipsHtml(sizeTally)}</span></div>
    `;

    function tonePill(tone) {
      if (!tone) return `<span class="dim">—</span>`;
      const cls = tone === "good" ? "good" : tone === "bad" ? "bad" : tone === "warn" ? "warn" : "neutral";
      return `<span class="pill ${cls}">${escapeHtml(tone === "warn" ? "off" : tone)}</span>`;
    }
    els.review.innerHTML = `
      <table class="quiz-review-table">
        <thead><tr><th>Symbol</th><th>Setup</th><th>Actual outcome</th><th>You</th><th>Entry read</th><th>Stop</th><th>Exit</th><th></th></tr></thead>
        <tbody>
          ${state.results.map((r) => `<tr>
            <td>${escapeHtml(r.symbol)}</td>
            <td>${escapeHtml((r.setup_type || "—").replace(/_/g, " "))}</td>
            <td><span class="pill ${r.win ? "win" : "loss"}">${r.win ? "Win" : "Loss"}</span></td>
            <td>${r.entered ? "Entered" : "Passed"}</td>
            <td>${tonePill(r.entryTone)}</td>
            <td>${tonePill(r.stopTone)}</td>
            <td>${tonePill(r.exitTone)}</td>
            <td>${r.source === "backtest" ? `<span class="dim">—</span>` : `<a href="trade.html?id=${encodeURIComponent(r.id)}" target="_blank" rel="noopener">view</a>`}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    `;

    const toReview = {};
    state.results.forEach((r) => { if (r.entryTone !== "good") toReview[r.setup_type || "unspecified"] = (toReview[r.setup_type || "unspecified"] || 0) + 1; });
    const sessionSource = state.results.length && state.results.every((r) => r.source === "backtest") ? "backtest" : "log";
    saveHistoryEntry({ date: window.MarketDate ? window.MarketDate.today() : new Date().toISOString().slice(0, 10), count: total, entered, passed, entryTally, toReview, source: sessionSource });
  }

  els.againBtn.addEventListener("click", () => {
    const filters = state.lastFilters || getFilters();
    const rows = getCandidateRows(filters);
    if (state.source === "backtest") rows.forEach((r) => { state.detailCache[r.id] = r; });
    startQuiz(filters, rows.map((r) => r.id));
  });
  els.reviewMissedBtn.addEventListener("click", async () => {
    const shakyIds = state.results.filter((r) => r.entryTone !== "good").map((r) => r.id);
    if (!shakyIds.length) { await UIModal.alert("Nothing to revisit — every entry read as a good call!", { title: "Nothing shaky here" }); return; }
    const filters = state.lastFilters || getFilters();
    startQuiz(filters, shakyIds);
  });
  els.backToSetupBtn.addEventListener("click", goToSetupScreen);
  Object.assign(R, { finishQuiz, goToReveal });
})();
