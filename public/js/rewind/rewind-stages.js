(function () {
  "use strict";
  const R = (window.RewindKit = window.RewindKit || {});
  const { BAR_SECONDS, COLOR_YOUR_STOP, SIZE_BASELINE, SIZE_PRESETS, STOP_PRESETS, buildChart, buildFormingBar, displayLabel, els, entryTickCount, fmtClock, getEntryWatchTicks, pushFormingBarPrice, runSecondReplay, showStageError, state } = R;
  const goToReveal = (...args) => R.goToReveal(...args);
  const renderWatchStage = (...args) => R.renderWatchStage(...args);

  function renderEntryStage() {
    const c = state.current;
    const trade = c.trade;
    const label = displayLabel(trade);
    const entryBar = c.bars[c.entryIdx];
    const entryUnix = toUnix(`${trade.trade_date} ${trade.entry_time}`);
    const secondsIntoBar = Math.max(0, entryUnix - toUnix(entryBar.t));
    const secondsRemaining = Math.max(0, BAR_SECONDS - secondsIntoBar);
    c.entrySecondsIntoBar = secondsIntoBar;
    const formingBar = buildFormingBar(entryBar);
    const visibleBars = c.bars.slice(0, c.entryIdx).concat([formingBar]);
    const sidePretty = c.side === "short" ? "short" : "long";

    els.card.innerHTML = `
      <div class="quiz-card-head">
        <div class="quiz-symbol-line">
          <span>${escapeHtml(label.name)}</span>
          ${label.date ? `<span class="dim" style="font-weight:400; font-size:13px;">${escapeHtml(label.date)}</span>` : ""}
          <span class="side-pill ${sidePretty}">${sidePretty}</span>
          <span class="pill" style="${window.setupTagStyleAttr(trade.setup_type || 'unlabeled setup')}">${escapeHtml((trade.setup_type || "unlabeled setup").replace(/_/g, " "))}</span>
        </div>
        <span class="quiz-clock">${escapeHtml(trade.entry_time)}
          <span class="quiz-live-badge"><span class="quiz-live-dot"></span>${fmtClock(secondsRemaining)} left on this candle</span>
        </span>
      </div>
      <div class="quiz-chart-wrap"><div id="quiz-candle-chart"></div></div>
      <div class="quiz-prompt" id="qz-entry-prompt">
        Price is at <b>$${fmtPrice(trade.entry_price)}</b> and this candle is still forming — you're deciding mid-bar, not after the close. This is a <b>${sidePretty}</b> setup. <b>Would you enter here?</b>
      </div>
      <div class="quiz-answer-row" id="quiz-entry-answer-row">
        <button class="quiz-answer-btn enter" id="qz-enter">Enter the trade <span class="kbd">Y</span></button>
        <button class="quiz-answer-btn pass" id="qz-pass">Pass <span class="kbd">N</span></button>
      </div>
      <div id="quiz-entry-replay-slot"><div class="quiz-replay-loading">${state.tickMode === "real" ? "Loading real ticks…" : "Loading…"}</div></div>
      <div id="quiz-stop-slot"></div>
    `;

    teardownChart(c.chartHandle);
    c.chartHandle = buildChart(document.getElementById("quiz-candle-chart"), visibleBars, { height: 380 });

    document.getElementById("qz-enter").addEventListener("click", () => handleEntryChoice(true, trade.entry_price));
    document.getElementById("qz-pass").addEventListener("click", () => handleEntryChoice(false));

    // The tape starts printing the moment this screen loads -- no button
    // to press first. Press Enter (or Pass) at whatever moment feels right
    // while the ticks print in, and that tick's price -- not necessarily
    // the real fill -- becomes your entry price. If you never click and it
    // runs out, it defaults to entering right at the real fill (same as
    // never having watched at all). The static Enter/Pass row above stays
    // live in the meantime, so a click during the brief load is still
    // honored at the real fill price.
    const answerRow = document.getElementById("quiz-entry-answer-row");
    const prevCloseEntry = c.entryIdx > 0 ? c.bars[c.entryIdx - 1].c : entryBar.o;
    c.entryBarPrevClose = prevCloseEntry;
    getEntryWatchTicks(trade, entryBar, prevCloseEntry, secondsIntoBar, c.avgVolume).then(({ prices, real, fellBack }) => {
      if (state.current !== c || c.stage !== "entry") return;
      try {
      // Removed (not just hidden): the replay below creates its own
      // #qz-enter/#qz-pass buttons, and a hidden duplicate of those same
      // ids left in the DOM would silently win every document.getElementById
      // lookup -- including the Y/N/Enter/Escape keyboard shortcuts -- so
      // pressing a key would lock in the real fill price instead of
      // whatever tick you were actually watching.
      answerRow.remove();
      c.replayHandle = runSecondReplay(document.getElementById("quiz-entry-replay-slot"), prices, {
        unitLabel: real ? "tick" : "second",
        tag: real ? "live ticks · server" : "simulated seconds",
        tagCls: real ? "live" : "",
        fallbackNote: fellBack ? "No live ticks came back for this window — showing the simulated path instead." : "",
        actions: [
          { id: "enter", label: "Enter", kbd: "Y", cls: "enter" },
          { id: "pass", label: "Pass", kbd: "N", cls: "pass" },
        ],
        defaultActionId: "pass", // running out the clock without deciding = you didn't take it
        chartHandle: c.chartHandle,
        bar: entryBar,
        onAct: (actionId, tickIdx, price) => handleEntryChoice(actionId === "enter", price, tickIdx),
      });
      } catch (err) { showStageError(err); }
    }).catch(showStageError);

    c.stage = "entry";
  }

  // How long to hold on the entered/passed candle before moving into the
  // next stage -- previously this was instant, so entering (or passing)
  // snapped straight into the stop-loss prompt with no beat to actually
  // see where the fill landed.
  const ENTRY_SETTLE_MS = 1600;

  // tickIdx (0-based, in the REPLAY_SECONDS space) is only given when the
  // choice came from clicking during "Watch it print in" -- it's exactly
  // which tick you clicked on. When it's missing (you decided straight
  // from the static prompt, without watching), we derive the equivalent
  // index from the real fill's time into the bar, using the same rounding
  // the tape's own cutoff uses, so both paths agree on one tick index.
  function handleEntryChoice(entered, price, tickIdx) {
    const c = state.current;
    try {
    if (c.replayHandle) { c.replayHandle.stop(); c.replayHandle = null; } // stop an in-progress "watch it print in" replay
    c.entered = entered;
    if (entered) {
      c.userEntryPrice = Number.isFinite(price) ? price : c.trade.entry_price;
      c.entryTickIdx = Number.isFinite(tickIdx)
        ? tickIdx
        : entryTickCount(c.entrySecondsIntoBar || 0) - 1;
      // If the tape was watched, its own live-painted candle already
      // reflects this price -- only push it here for the un-watched path,
      // where the chart is still sitting flat at the open.
      if (!Number.isFinite(tickIdx)) {
        const entryBar = c.bars[c.entryIdx];
        pushFormingBarPrice(c.chartHandle, entryBar, c.userEntryPrice, c.entrySecondsIntoBar || 0);
      }
    }
    const enterBtn = document.getElementById("qz-enter");
    const passBtn = document.getElementById("qz-pass");
    if (enterBtn) enterBtn.disabled = true;
    if (passBtn) passBtn.disabled = true;
    const promptEl = document.getElementById("qz-entry-prompt");
    if (promptEl) {
      promptEl.innerHTML = entered
        ? `Filled at <b>$${fmtPrice(c.userEntryPrice)}</b>…`
        : `Passed.`;
    }
    setTimeout(() => {
      if (state.current !== c) return; // moved on (retry/quit/next question) while we were waiting
      if (entered) renderStopStage();
      else goToReveal();
    }, ENTRY_SETTLE_MS);
    } catch (err) { showStageError(err); }
  }

  // ---------- Stage B: stop-loss + position size ----------
  function renderStopStage() {
    const c = state.current;
    const trade = c.trade;
    const entryPrice = c.userEntryPrice;
    const slot = document.getElementById("quiz-stop-slot");

    // Default stop suggestion: reach for structure first -- the low of
    // the last fully-formed candle for a long, the high of it for a
    // short -- since that's the level a trader would actually reference,
    // not an arbitrary percentage. c.entryIdx - 1 is the last candle
    // that's fully known (the entry candle itself is still only
    // partially revealed at this point). Falls back to the flat 1%
    // preset when there's no prior candle yet (entry on the very first
    // bar of the dataset) or when that level would sit on the wrong
    // side of -- or right on top of -- entry, which can happen on a gap.
    const prevBar = c.entryIdx > 0 ? c.bars[c.entryIdx - 1] : null;
    const structurePrice = prevBar ? (c.side === "short" ? prevBar.h : prevBar.l) : null;
    const structureRisk = structurePrice != null ? (c.side === "short" ? structurePrice - entryPrice : entryPrice - structurePrice) : 0;
    const structureValid = structurePrice != null && structureRisk > 0;
    const structureLabel = c.side === "short" ? "Prior high" : "Prior low";
    const standardPreset = STOP_PRESETS.find((p) => p.pct === 1) || STOP_PRESETS[0];

    slot.innerHTML = `
      <div class="quiz-stop-panel">
        <div class="quiz-prompt" style="margin-top:0;">You're in at <b>$${fmtPrice(entryPrice)}</b>. Set your stop and size below — click the chart any time to move the stop.</div>
        <div class="quiz-stop-grid">
          <div class="qsg-col">
            <div class="qsg-label">Stop-loss</div>
            <div class="quiz-preset-row" id="quiz-stop-presets">
              ${structureValid ? `<button class="quiz-preset-btn active" data-kind="structure">${structureLabel} <span class="dim">· $${fmtPrice(structurePrice)}</span></button>` : ""}
              ${STOP_PRESETS.map((p) => `<button class="quiz-preset-btn${!structureValid && p === standardPreset ? " active" : ""}" data-kind="pct" data-pct="${p.pct}">${p.label} <span class="dim">· ${p.sub}</span></button>`).join("")}
              <button class="quiz-preset-btn" data-kind="custom">Custom</button>
            </div>
            <div class="quiz-stop-row">
              <input type="number" step="0.0001" id="quiz-stop-input" placeholder="e.g. ${fmtPrice(c.side === "short" ? entryPrice * 1.02 : entryPrice * 0.98)}">
            </div>
            <div class="quiz-risk-preview" id="quiz-risk-preview"></div>
          </div>
          <div class="qsg-col">
            <div class="qsg-label">Size</div>
            <div class="quiz-preset-row" id="quiz-size-presets">
              ${SIZE_PRESETS.map((p) => `<button class="quiz-preset-btn${p.shares === SIZE_BASELINE ? " active" : ""}" data-shares="${p.shares}">${p.label} <span class="dim">· ${p.sub}</span></button>`).join("")}
              <button class="quiz-preset-btn" data-shares="">Custom</button>
            </div>
            <div class="quiz-size-row">
              <input type="number" step="1" min="1" id="quiz-size-input" value="${SIZE_BASELINE}">
              <span class="quiz-size-unit">shares</span>
            </div>
            <div class="quiz-size-preview" id="quiz-size-risk-preview"></div>
          </div>
        </div>

        <div class="quiz-stop-row" style="margin-top:10px;">
          <button class="quiz-answer-btn enter" id="quiz-stop-confirm" style="flex:none; min-width:150px;">Lock in <span class="kbd">↵</span></button>
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
        price, color: COLOR_YOUR_STOP, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted,
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
        const kind = btn.dataset.kind;
        if (kind === "structure") {
          input.value = fmtPrice(structurePrice);
          setPreview(structurePrice);
        } else if (kind === "pct") {
          const pct = Number(btn.dataset.pct);
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
      stopPresetBtns.forEach((b) => b.classList.toggle("active", b.dataset.kind === "custom"));
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
      stopPresetBtns.forEach((b) => b.classList.toggle("active", b.dataset.kind === "custom"));
      setPreview(price);
    });

    // Pre-fill and preview the default the moment the stage renders --
    // structure when it's usable, otherwise the flat 1% preset -- instead
    // of leaving the input empty until you pick something yourself.
    if (structureValid) {
      input.value = fmtPrice(structurePrice);
      setPreview(structurePrice);
    } else {
      const mult = c.side === "short" ? 1 + standardPreset.pct / 100 : 1 - standardPreset.pct / 100;
      const price = entryPrice * mult;
      input.value = fmtPrice(price);
      setPreview(price);
    }

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
    c.buys = [{ shares: c.userShares, price: c.userEntryPrice, barIdx: c.entryIdx, tickIdx: c.entryTickIdx, tag: "entry" }];
    c.openShares = c.userShares;
    c.avgCost = c.userEntryPrice;
    const slot = document.getElementById("quiz-stop-slot");
    if (slot) slot.querySelectorAll("button, input").forEach((elm) => (elm.disabled = true));
    renderWatchStage();
  }

  // Records a closed tranche, in SHARE units -- clamps to whatever's
  // actually still open so a stray double-click (or a stop firing after
  // you'd already sold) can't oversell. Returns the shares actually
  // closed (0 if nothing was left to sell).
  function recordExit(c, shares, price, barIdx, tickIdx, tag) {
    const applied = Math.max(0, Math.min(shares, c.openShares));
    if (applied <= 1e-9 || !Number.isFinite(price)) return 0;
    c.exits.push({ shares: applied, price, barIdx, tickIdx, tag });
    c.openShares = Math.max(0, c.openShares - applied);
    if (!c.checkpointAction) c.checkpointAction = "exit";
    c.exitBarIdx = barIdx;
    c.exitSecond = tickIdx;
    c.userExitPrice = price; // last exit's price -- kept for anything that only cares about "how it finally ended"
    return applied;
  }

  // Records adding to the position mid-trade -- rolls the added shares
  // into the running average-cost basis of whatever's open. Selling never
  // touches this; only buying does. Returns the shares actually added.
  function recordAdd(c, shares, price, barIdx, tickIdx) {
    if (!(shares > 0) || !Number.isFinite(price)) return 0;
    c.buys.push({ shares, price, barIdx, tickIdx, tag: "add" });
    const newOpen = c.openShares + shares;
    c.avgCost = ((c.avgCost != null ? c.avgCost : price) * c.openShares + price * shares) / newOpen;
    c.openShares = newOpen;
    return shares;
  }
  Object.assign(R, { recordAdd, recordExit, renderEntryStage });
})();
