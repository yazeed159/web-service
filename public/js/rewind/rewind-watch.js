(function () {
  "use strict";
  const R = (window.RewindKit = window.RewindKit || {});
  const { COLOR_YOUR_ENTRY, COLOR_YOUR_STOP, REPLAY_SECONDS, SIZE_BASELINE, attachEndOfDataLine, buildChart, displayLabel, els, finalizeBarOnChart, fmtSignedPerShare, getCheckpointTicks, getEntryBarRemainderTicks, recordAdd, recordExit, runSecondReplay, showStageError, state } = R;
  const goToReveal = (...args) => R.goToReveal(...args);

  // ---------- Stage C: watch continuously from your entry until you exit ----------
  // Instead of jumping to one designated "checkpoint" bar, you now keep
  // watching bar after bar -- tick by tick -- from right after your entry
  // for as long as there's chart left to show. You can click Exit at any
  // point during any of it. Your own stop is checked live against every
  // tick as it prints, so it can trigger mid-bar exactly like a real fill
  // would, regardless of where the real entry/exit actually landed.
  function renderWatchStage() {
    const c = state.current;
    // Resume from the entry bar itself if there was any of it left when
    // you entered -- watchIdx === entryIdx means "still finishing this
    // candle". Only once that's played out do we move on to entryIdx + 1.
    // (Previously this always jumped straight to entryIdx + 1, silently
    // skipping whatever time was left on the candle you actually entered
    // on.)
    const hasEntryBarRemainder = c.entryTickIdx != null && c.entryTickIdx < REPLAY_SECONDS - 1;
    c.watchIdx = hasEntryBarRemainder ? c.entryIdx : c.entryIdx + 1;
    if (c.watchIdx > c.bars.length - 1) {
      // Nothing left to watch after entry -- go straight to reveal, same
      // outcome as watching through to the end of the data and never
      // clicking Exit.
      goToReveal();
      return;
    }
    buildWatchScreen();
  }

  // Builds the watch-stage DOM and chart exactly once per question. Bars
  // after this are played by renderWatchBar(), which only touches the
  // header text and the replay panel -- the chart itself is never torn
  // down and rebuilt again, so your zoom/pan (and the tape) stay put
  // candle after candle instead of snapping back to a full-fit view.
  function buildWatchScreen() {
    const c = state.current;
    try {
    const trade = c.trade;
    const entryPrice = c.userEntryPrice;

    els.card.innerHTML = `
      <div class="quiz-card-head">
        <div class="quiz-symbol-line">
          <span>${escapeHtml(displayLabel(trade).name)}</span>
          <span class="side-pill ${c.side}">${c.side}</span>
        </div>
        <span class="quiz-clock">
          <span id="qz-watch-clock"></span>
          <span class="quiz-live-badge pos" id="qz-watch-live-clock" style="display:none;"></span>
        </span>
      </div>
      <div class="quiz-chart-wrap"><div id="quiz-candle-chart"></div></div>
      <div class="quiz-prompt" id="qz-watch-prompt"></div>
      <div class="qz-manage-row" id="qz-manage-row">
        <div class="qz-manage-group">
          <span class="qz-manage-label">Stop</span>
          <b id="qz-stop-live-price">$${fmtPrice(c.stopPrice)}</b>
          <button type="button" class="btn-advanced qz-move-stop-btn" id="qz-move-stop-btn">Move stop <span class="kbd">S</span></button>
        </div>
        <div class="qz-manage-group">
          <span class="qz-manage-label">Add to position</span>
          <input type="number" min="1" step="1" id="qz-add-shares" value="${c.userShares}">
          <button type="button" class="quiz-answer-btn add" id="qz-add-btn">+ Add <span class="kbd">A</span></button>
        </div>
        <span class="quiz-stop-hint" id="qz-manage-error"></span>
      </div>
      <div class="quiz-partial-row" id="qz-partial-row"></div>
      <div id="quiz-replay-slot"></div>
    `;
    c.stage = "watch";

    // Scale-out buttons -- wired once here (not rebuilt every tick/bar like
    // the replay panel's Exit button) so they stay live and clickable the
    // whole way through the watch stage, including the brief gap between
    // one bar's tape ending and the next one's ticks arriving. Sell ¼/½
    // act on whatever's open RIGHT NOW, not the original size -- so it
    // still means the same thing after you've added to (or already
    // trimmed) the position.
    document.getElementById("qz-partial-row").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-sell]");
      if (!btn || btn.disabled) return;
      const frac = Number(btn.dataset.sell);
      if (!(frac > 0)) return;
      const handle = c.replayHandle;
      const price = handle && typeof handle.getPrice === "function" ? handle.getPrice() : null;
      if (!Number.isFinite(price)) return;
      const tickIdx = handle && typeof handle.getIndex === "function" ? handle.getIndex() : null;
      const shares = Math.max(1, Math.round(c.openShares * frac));
      const applied = recordExit(c, shares, price, c.watchIdx, tickIdx, "sell");
      if (applied <= 0) return;
      if (c.openShares <= 1e-9) {
        if (c.replayHandle) { c.replayHandle.stop(); c.replayHandle = null; }
        goToReveal();
      } else {
        renderPartialRow();
      }
    });

    // Add-to-position + move-stop controls -- wired once here too, on the
    // persistent #qz-manage-row (unlike #qz-partial-row this is never
    // re-rendered mid-stage, so a half-typed share count in the Add input
    // survives from bar to bar instead of getting wiped every tick).
    document.getElementById("qz-add-btn").addEventListener("click", () => doAddToPosition());
    document.getElementById("qz-add-shares").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); doAddToPosition(); }
    });
    document.getElementById("qz-move-stop-btn").addEventListener("click", () => {
      c.moveStopArmed = !c.moveStopArmed;
      setMoveStopBtnState();
    });

    teardownChart(c.chartHandle);
    // Everything before the bar currently playing is settled chart
    // history; the current (and every later) bar plays out second by
    // second instead of showing up as an already-closed candle.
    const historyBars = c.bars.slice(0, c.watchIdx);
    const watchPriceLines = [
      { key: "entry", price: entryPrice, color: COLOR_YOUR_ENTRY, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, lineVisible: true, axisLabelVisible: true, title: "your entry" },
      { key: "stop", price: c.stopPrice, color: COLOR_YOUR_STOP, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, lineVisible: true, axisLabelVisible: true, title: "your stop" },
    ];
    // Deliberately no "real entry"/"real exit" lines or pointers here --
    // the trade is still live at this stage, and showing where the real
    // fills landed (or even that they differ from yours) would spoil the
    // outcome before the reveal screen. Those only show up once you've
    // finished the trade.
    const chartEl = document.getElementById("quiz-candle-chart");
    // Fall back to just this one bar only when there's truly no earlier
    // history (watchIdx is the very first bar of the dataset) -- for the
    // entry-bar-remainder case there's no fallback needed since the
    // entry bar itself isn't finished yet and must not be shown as an
    // already-closed candle.
    c.chartHandle = buildChart(chartEl, historyBars.length ? historyBars : (c.watchIdx > 0 ? c.bars.slice(0, c.watchIdx + 1) : []), {
      height: 380,
      priceLines: watchPriceLines,
    });
    // Mark the last bar you actually have data for, so it's visible at a
    // glance how much runway is left instead of only finding out once
    // the tape runs dry.
    attachEndOfDataLine(chartEl, c.chartHandle, toUnix(c.bars[c.bars.length - 1].t));

    // Clicking the chart while "Move stop" is armed relocates the stop to
    // that price -- same click-to-place gesture the stop stage already
    // uses, just gated behind the button so an ordinary click (panning,
    // checking a level) doesn't silently drag your stop around.
    c.chartHandle.chart.subscribeClick((param) => {
      const cc = state.current;
      if (!cc || cc !== c || cc.stage !== "watch" || !cc.moveStopArmed) return;
      if (!param.point || !cc.chartHandle.series) return;
      const price = cc.chartHandle.series.coordinateToPrice(param.point.y);
      if (price == null) return;
      setLiveStop(price);
    });

    renderPartialRow();
    setMoveStopBtnState();
    renderWatchBar();
    } catch (err) { showStageError(err); }
  }

  // Repositions the stop while the trade is live -- from the "Move stop"
  // button + chart click, not the one-time stop stage. Rejects a price
  // that would trigger immediately against the current live tick (same
  // as a real broker bouncing a marketable stop) instead of silently
  // accepting it and firing on the very next tick.
  function setLiveStop(price) {
    const c = state.current;
    if (!c || c.stage !== "watch" || !Number.isFinite(price) || price <= 0) return;
    const handle = c.replayHandle;
    const liveTick = handle && typeof handle.getPrice === "function" ? handle.getPrice() : null;
    const errorEl = document.getElementById("qz-manage-error");
    if (Number.isFinite(liveTick)) {
      const wouldTrigger = c.side === "short" ? price <= liveTick : price >= liveTick;
      if (wouldTrigger) {
        if (errorEl) {
          errorEl.textContent = `That's through the current price ($${fmtPrice(liveTick)}) — it'd trigger immediately.`;
          setTimeout(() => { if (state.current === c && errorEl.isConnected) errorEl.textContent = ""; }, 2600);
        }
        return;
      }
    }
    c.stopPrice = price;
    const ref = c.chartHandle.priceLineRefs && c.chartHandle.priceLineRefs.stop;
    if (ref) ref.applyOptions({ price });
    const label = document.getElementById("qz-stop-live-price");
    if (label) label.textContent = `$${fmtPrice(price)}`;
    if (errorEl) errorEl.textContent = "";
    c.moveStopArmed = false;
    setMoveStopBtnState();
  }

  function setMoveStopBtnState() {
    const c = state.current;
    const btn = document.getElementById("qz-move-stop-btn");
    if (!btn || !c) return;
    btn.classList.toggle("active", !!c.moveStopArmed);
    btn.innerHTML = c.moveStopArmed
      ? `Click chart to place it <span class="kbd">Esc</span>`
      : `Move stop <span class="kbd">S</span>`;
  }

  // Adds shares to the open position at the current live tick, folding
  // them into the running average-cost basis and refreshing the entry
  // line on the chart to read "avg cost" once it's no longer just the
  // single original fill.
  function doAddToPosition() {
    const c = state.current;
    if (!c || c.stage !== "watch") return;
    const input = document.getElementById("qz-add-shares");
    const shares = Math.round(Number(input && input.value));
    const errorEl = document.getElementById("qz-manage-error");
    if (!Number.isFinite(shares) || shares <= 0) {
      if (errorEl) errorEl.textContent = "Enter a valid number of shares to add.";
      return;
    }
    const handle = c.replayHandle;
    const price = handle && typeof handle.getPrice === "function" ? handle.getPrice() : null;
    if (!Number.isFinite(price)) {
      if (errorEl) errorEl.textContent = "No live price to add at right now.";
      return;
    }
    const tickIdx = handle && typeof handle.getIndex === "function" ? handle.getIndex() : null;
    recordAdd(c, shares, price, c.watchIdx, tickIdx);
    if (errorEl) errorEl.textContent = "";
    const ref = c.chartHandle.priceLineRefs && c.chartHandle.priceLineRefs.entry;
    if (ref) ref.applyOptions({ price: c.avgCost, title: "avg cost" });
    renderPartialRow();
  }

  // Refreshes the persistent scale-out row: how many shares are still
  // open (the actual number, not just a percentage), what's already been
  // sold or added and at what price, and which Sell buttons still make
  // sense given what's left.
  function renderPartialRow() {
    const c = state.current;
    if (!c || c.stage !== "watch") return;
    const row = document.getElementById("qz-partial-row");
    if (!row) return;
    const soldParts = c.exits.filter((e) => e.tag === "sell").map((e) => `${e.shares} sh at $${fmtPrice(e.price)}`);
    const addedParts = c.buys.filter((b) => b.tag === "add").map((b) => `${b.shares} sh at $${fmtPrice(b.price)}`);
    row.innerHTML = `
      <span class="qp-status">Holding <b>${c.openShares} sh</b>${soldParts.length ? ` <span class="dim">\u00b7 sold ${escapeHtml(soldParts.join(", "))}</span>` : ""}${addedParts.length ? ` <span class="dim">\u00b7 added ${escapeHtml(addedParts.join(", "))}</span>` : ""}</span>
      <div class="qp-btns">
        <button type="button" class="quiz-answer-btn partial" data-sell="0.25"${c.openShares < 1 ? " disabled" : ""}>Sell &frac14; <span class="kbd">2</span></button>
        <button type="button" class="quiz-answer-btn partial" data-sell="0.5"${c.openShares < 1 ? " disabled" : ""}>Sell &frac12; <span class="kbd">3</span></button>
      </div>
    `;
  }

  function renderWatchBar() {
    const c = state.current;
    try {
    const trade = c.trade;
    const entryPrice = c.userEntryPrice;
    // watchIdx === entryIdx means we're still finishing out the candle
    // you entered on, tick by tick from your fill -- not yet a fresh bar.
    const isEntryRemainder = c.watchIdx === c.entryIdx;
    const historyBars = c.bars.slice(0, c.watchIdx);
    const bar = c.bars[c.watchIdx];
    // Feeds the deterministic simulated path -- for the entry bar's
    // remainder this must be the exact value the pre-entry tape used
    // (c.entryBarPrevClose), so both halves of the same candle are the
    // same underlying walk instead of visibly disagreeing at the seam.
    const tickPrevClose = isEntryRemainder
      ? (c.entryBarPrevClose != null ? c.entryBarPrevClose : entryPrice)
      : (historyBars.length ? historyBars[historyBars.length - 1].c : entryPrice);
    // "Unrealized so far" for the remainder should read off your own
    // fill (you only just entered), not the close of the bar before it.
    // Once you've added to the position, it's measured off the blended
    // average cost of what's actually still open, not the original fill.
    const costBasis = c.avgCost != null ? c.avgCost : entryPrice;
    const unrealized = pnlPerShare(costBasis, isEntryRemainder ? entryPrice : tickPrevClose, c.side);
    const clockStr = new Date(bar.t.replace(" ", "T")).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const minutesIn = c.watchIdx - c.entryIdx;
    const barsLeft = c.bars.length - 1 - c.watchIdx;
    // Always shown, not just as a last-second warning -- so you can see
    // how much tape is left to plan around rather than getting surprised
    // when it runs out. BAR_SECONDS === 60, so bars left and minutes left
    // of chart data are the same number.
    const barsLeftColor = barsLeft <= 3 ? "var(--amber)" : "var(--text-faint)";
    const barsLeftLabel = `${barsLeft} bar${barsLeft === 1 ? "" : "s"} (~${barsLeft}m) of data left`;

    document.getElementById("qz-watch-clock").innerHTML =
      `${escapeHtml(clockStr)} <span class="dim" style="font-weight:400;">· ${minutesIn} min in</span>` +
      ` <span style="color:${barsLeftColor};">· ${barsLeftLabel}</span>`;
    const avgCostNote = c.buys.length > 1 ? ` <span class="dim">(avg cost $${fmtPrice(c.avgCost)})</span>` : "";
    document.getElementById("qz-watch-prompt").innerHTML = `
      You're in at <b>$${fmtPrice(entryPrice)}</b>${avgCostNote}, stop at <b>$${fmtPrice(c.stopPrice)}</b>, holding <b>${c.openShares} sh</b>.
      Unrealized so far on the open size: <b style="color:${unrealized >= 0 ? "var(--green)" : "var(--red)"}">${fmtSignedPerShare(unrealized)}/sh</b>.
      Keep watching for as long as you like — <b>sell some, add more, or get out whenever you'd get out</b>.
    `;
    renderPartialRow();

    const replaySlot = document.getElementById("quiz-replay-slot");
    replaySlot.innerHTML = `<div class="quiz-replay-loading">${state.tickMode === "real" ? "Loading real ticks from the server…" : "Loading…"}</div>`;
    const liveClockEl = document.getElementById("qz-watch-live-clock");
    if (liveClockEl) liveClockEl.style.display = "none";
    // Nothing to sell against mid-fetch -- lock the scale-out buttons for
    // this brief gap rather than let a click read a stale/no price.
    document.querySelectorAll('#qz-partial-row button[data-sell]').forEach((b) => (b.disabled = true));

    const watchIdxAtFetch = c.watchIdx;
    const ticksPromise = isEntryRemainder
      ? getEntryBarRemainderTicks(trade, bar, tickPrevClose, c.entryTickIdx, c.avgVolume, c.userEntryPrice)
      : getCheckpointTicks(trade, bar, tickPrevClose, c.avgVolume);
    ticksPromise.then(({ prices, real, fellBack }) => {
      if (state.current !== c || c.stage !== "watch" || c.watchIdx !== watchIdxAtFetch) return; // moved on while this was in flight
      try {
      if (!prices.length) {
        // You entered right on the bar's final tick -- nothing left of
        // this candle to watch, so finalize it and move on to the next
        // bar instead of trying to play an empty tape.
        finalizeBarOnChart(c.chartHandle, bar);
        c.watchIdx += 1;
        if (c.watchIdx > c.bars.length - 1) { goToReveal(); return; }
        renderWatchBar();
        return;
      }
      if (liveClockEl) liveClockEl.style.display = "";
      renderPartialRow();
      c.replayHandle = runSecondReplay(replaySlot, prices, {
        unitLabel: real ? "tick" : "second",
        tag: real ? "live ticks · server" : "simulated seconds",
        tagCls: real ? "live" : "",
        fallbackNote: fellBack ? "No live ticks came back for this window — showing the simulated path instead." : "",
        // The chart already reflects everything through the previous bar
        // (or was just fit once in buildWatchScreen) -- re-fitting on
        // every later bar is exactly the "resets the chart view" behavior
        // this replaces, so skip it here.
        autoFit: false,
        // Once you're actually in the trade, replace the sweeping
        // "loading" progress bar with a plain ticking clock up in the
        // header -- closer to what a real trading platform looks like.
        hideProgress: true,
        liveClockEl,
        actions: [
          { id: "exit", label: `Exit all (${c.openShares} sh)`, kbd: "E", cls: "exit" },
        ],
        chartHandle: c.chartHandle,
        bar,
        // Continuing the entry bar's own candle: seed the wick from what
        // it already showed (open..your fill) instead of resetting it
        // flat, and keep volume accumulating past what already printed.
        seedHigh: isEntryRemainder ? Math.max(bar.o, entryPrice) : undefined,
        seedLow: isEntryRemainder ? Math.min(bar.o, entryPrice) : undefined,
        volStartFrac: isEntryRemainder ? (c.entryTickIdx + 1) / REPLAY_SECONDS : 0,
        onTick: (price, tickIdx) => {
          const breached = c.side === "short" ? price >= c.stopPrice : price <= c.stopPrice;
          if (breached) {
            if (c.replayHandle) { c.replayHandle.stop(); c.replayHandle = null; }
            c.stoppedOutEarly = true;
            c.stopOutIdx = c.watchIdx;
            // A stop only closes out whatever's still open -- any earlier
            // partial sells keep their own locked-in prices.
            recordExit(c, c.openShares, c.stopPrice, c.watchIdx, tickIdx, "stop");
            goToReveal();
          }
        },
        onExhausted: () => {
          // This bar's tape ran out without you clicking Exit -- finalize
          // it on the chart (swap from the orange forming look to its
          // normal closed color) and move straight on to the next bar,
          // without touching the DOM or rebuilding the chart.
          finalizeBarOnChart(c.chartHandle, bar);
          c.watchIdx += 1;
          if (c.watchIdx > c.bars.length - 1) { goToReveal(); return; } // out of chart to watch
          renderWatchBar();
        },
        onAct: (actionId, tickIdx, price) => {
          // Exit all -- closes whatever's still open, whether that's the
          // full position, whatever's left after earlier partial sells,
          // or a bigger size than you started with after adding.
          recordExit(c, c.openShares, price, c.watchIdx, tickIdx, "sell");
          goToReveal();
        },
      });
      } catch (err) { showStageError(err); }
    }).catch(showStageError);
    } catch (err) { showStageError(err); }
  }

  // ---------- feedback (qualitative — good/off/bad, never a score) ----------
  // gradeEntry() now in utils.js (loads first on every page).

  // gradeStop() now in utils.js (loads first on every page).

  function computeGrading(c) {
    const trade = c.trade;
    const side = c.side;
    const entryPrice = c.userEntryPrice;
    const entryGrade = gradeEntry(trade.win, c.entered);

    let stopGrade = null, exitGrade = null, userPnlPerShare = null, userExitFillPrice = null;
    let userRealizedTotal = null, userSharesClosed = null, userTotalShares = null, userFinalAvgCost = null;
    if (c.entered) {
      stopGrade = gradeStop(side, entryPrice, c.stopPrice, trade.suggested_stop);
      const actualPnl = pnlPerShare(entryPrice, trade.exit_price, side);

      // Walk every buy and sell in the order they happened, tracking a
      // running average-cost basis -- this is what makes "add to
      // position" and "sell some" both fold correctly into one blended
      // P&L, instead of assuming a fixed size bought once at entryPrice.
      // c.exits is fully normalized by the time reveal calls this (it
      // always accounts for every share bought -- goToReveal tops up
      // whatever was still open with a "held to end" tranche first).
      const legs = c.buys.map((b) => Object.assign({ type: "buy" }, b))
        .concat(c.exits.map((e) => Object.assign({ type: "sell" }, e)))
        .sort((a, b) => {
          const barDiff = (a.barIdx == null ? 0 : a.barIdx) - (b.barIdx == null ? 0 : b.barIdx);
          if (barDiff !== 0) return barDiff;
          return (a.tickIdx == null ? 0 : a.tickIdx) - (b.tickIdx == null ? 0 : b.tickIdx);
        });
      let openShares = 0, costBasis = entryPrice, realizedTotal = 0, sharesSold = 0, exitPriceWeighted = 0;
      legs.forEach((leg) => {
        if (leg.type === "buy") {
          costBasis = openShares > 0 ? (costBasis * openShares + leg.price * leg.shares) / (openShares + leg.shares) : leg.price;
          openShares += leg.shares;
        } else {
          const perShare = side === "short" ? costBasis - leg.price : leg.price - costBasis;
          realizedTotal += perShare * leg.shares;
          sharesSold += leg.shares;
          exitPriceWeighted += leg.price * leg.shares;
          openShares -= leg.shares;
        }
      });
      userTotalShares = c.buys.reduce((s, b) => s + b.shares, 0);
      userRealizedTotal = realizedTotal;
      userSharesClosed = sharesSold;
      userFinalAvgCost = costBasis;
      userPnlPerShare = sharesSold > 0 ? realizedTotal / sharesSold : 0;
      userExitFillPrice = sharesSold > 0 ? exitPriceWeighted / sharesSold : null;

      const manualTranches = c.exits.filter((e) => e.tag !== "held");
      const scaledOut = c.exits.filter((e) => e.tag === "sell").length > 1;
      const addedIn = c.buys.length > 1;

      if (c.stoppedOutEarly) {
        const stopShares = c.exits.filter((e) => e.tag === "stop").reduce((s, e) => s + e.shares, 0);
        exitGrade = stopShares < sharesSold - 1e-9
          ? { label: `Scaled out first, then stopped out of the rest at $${fmtPrice(c.stopPrice)}.`, tone: "warn" }
          : { label: `Stopped out at $${fmtPrice(c.stopPrice)} while you were watching.`, tone: "warn" };
      } else if (manualTranches.length) {
        const diff = actualPnl - userPnlPerShare;
        const threshold = Math.max(0.15 * Math.abs(actualPnl || 0.01), 0.01);
        const prefix = scaledOut ? `Scaled out across ${manualTranches.length} sells (avg $${fmtPrice(userExitFillPrice)}). ` : (addedIn ? `Added to the position along the way (avg cost $${fmtPrice(costBasis)}). ` : "");
        if (diff > threshold) exitGrade = { label: `${prefix}You exited early — the move kept going. Riding it to the real exit made ${fmtSignedPerShare(diff)}/sh more.`, tone: "warn" };
        else if (diff < -threshold) exitGrade = { label: `${prefix}Good exit — price gave back a lot of that move afterward.`, tone: "good" };
        else exitGrade = { label: `${prefix}Reasonable exit, close to how the trade actually played out.`, tone: "good" };
      } else {
        // Never sold anything and never got stopped -- you watched all the
        // way through to the end of the available chart, same as holding.
        exitGrade = { label: "You held on — matches what actually happened.", tone: "neutral" };
      }
    }

    // Size grading is independent of how the entry/stop/exit played out --
    // it's just: did your conviction (bigger size = more confident) line up
    // with how the trade actually turned out?
    let sizeGrade = null;
    if (c.entered && Number.isFinite(c.userShares)) {
      const ratio = c.userShares / SIZE_BASELINE;
      if (ratio >= 1.3 && trade.win) sizeGrade = { label: `Sized up to ${c.userShares} sh and it paid off — good conviction.`, tone: "good" };
      else if (ratio >= 1.3 && !trade.win) sizeGrade = { label: `Sized up to ${c.userShares} sh on a loser — that conviction cost you more.`, tone: "bad" };
      else if (ratio <= 0.7 && !trade.win) sizeGrade = { label: `Sized down to ${c.userShares} sh — good instinct, this one lost.`, tone: "good" };
      else if (ratio <= 0.7 && trade.win) sizeGrade = { label: `Sized down to ${c.userShares} sh on a winner — left size on the table.`, tone: "warn" };
      else sizeGrade = { label: `Standard size (${c.userShares} sh).`, tone: "neutral" };
    }

    return { entryGrade, stopGrade, exitGrade, sizeGrade, userPnlPerShare, userExitFillPrice, userRealizedTotal, userSharesClosed, userTotalShares, userFinalAvgCost };
  }
  Object.assign(R, { computeGrading, renderWatchStage, setMoveStopBtnState });
})();
