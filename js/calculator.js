// calculator.js — position-size / R-multiple calculator page logic.
// Used to be an inline <script> block in calculator.html; pulled out into
// its own file so it can be linted/diffed like every other page's script
// instead of being a special case (it and edge-analysis.html were the
// only two pages still doing this).

  (function () {
    "use strict";

    const LS_KEYS = {
      startingBalance: "calc_starting_balance",
      riskPct: "calc_risk_pct",
      stopMode: "calc_stop_mode",
      stopPct: "calc_stop_pct",
      winRate: "calc_win_rate",
    };

    const entryEl = document.getElementById("calc-entry");
    const stopEl = document.getElementById("calc-stop");
    const targetEl = document.getElementById("calc-target");
    const startingBalanceEl = document.getElementById("calc-starting-balance");
    const balanceDisplay = document.getElementById("calc-balance-display");
    const balanceSub = document.getElementById("calc-balance-sub");
    const balanceEditBtn = document.getElementById("calc-balance-edit-btn");
    const balanceEditWrap = document.getElementById("calc-balance-edit-wrap");
    const stopComputedEl = document.getElementById("calc-stop-computed");
    const stopPriceWrap = document.getElementById("calc-stop-price-wrap");
    const stopPctChipsWrap = document.getElementById("calc-stop-pct-chips");
    const symbolRow = document.getElementById("calc-recent-symbols-row");
    const symbolListEl = document.getElementById("calc-symbol-list");

    const maxSharesEl = document.getElementById("calc-max-shares");
    const riskAmountEl = document.getElementById("calc-risk-amount");
    const positionCostEl = document.getElementById("calc-position-cost");
    const positionPctEl = document.getElementById("calc-position-pct");
    const perShareRiskEl = document.getElementById("calc-per-share-risk");
    const r1El = document.getElementById("calc-r1");
    const r2El = document.getElementById("calc-r2");
    const r3El = document.getElementById("calc-r3");
    const r1RowEl = document.getElementById("calc-r1-row");
    const r2RowEl = document.getElementById("calc-r2-row");
    const r3RowEl = document.getElementById("calc-r3-row");
    const rTargetRowEl = document.getElementById("calc-r-target-row");
    const rTargetEl = document.getElementById("calc-r-target");
    const riskAmountSubEl = document.getElementById("calc-risk-amount-sub");
    const commissionEl = document.getElementById("calc-commission");
    const netRiskEl = document.getElementById("calc-net-risk");
    const netRiskSubEl = document.getElementById("calc-net-risk-sub");
    const qualityEmptyEl = document.getElementById("calc-quality-empty");
    const qualityGridEl = document.getElementById("calc-quality-grid");
    const netRewardEl = document.getElementById("calc-net-reward");
    const rrRatioEl = document.getElementById("calc-rr-ratio");
    const breakevenEl = document.getElementById("calc-breakeven");
    const evEl = document.getElementById("calc-ev");
    const evSubEl = document.getElementById("calc-ev-sub");
    const positionCostStat = positionCostEl.closest(".calc-stat");
    const summaryEl = document.getElementById("calc-summary");
    const streak3El = document.getElementById("calc-streak-3");
    const streak5El = document.getElementById("calc-streak-5");
    const streak10El = document.getElementById("calc-streak-10");
    const winRateActualEl = document.getElementById("calc-winrate-actual");

    let riskPct = parseFloat(localStorage.getItem(LS_KEYS.riskPct)) || 1;
    let stopMode = localStorage.getItem(LS_KEYS.stopMode) || "pct";
    let stopPct = parseFloat(localStorage.getItem(LS_KEYS.stopPct)) || 1;
    let startingBalance = parseFloat(localStorage.getItem(LS_KEYS.startingBalance));
    if (!isFinite(startingBalance)) startingBalance = 25000;
    let winRate = parseFloat(localStorage.getItem(LS_KEYS.winRate));
    if (!isFinite(winRate) || winRate <= 0 || winRate >= 100) winRate = 50;
    let latestEquityAfter = 0;

    // Recent-symbol chips (pulled from the journal below) just fill in the
    // entry price when tapped -- nothing downstream needs to remember which
    // one was clicked.

    // IBKR's "Tiered" US stock commission schedule -- same constants and
    // formula as ibkrTieredCommission() in practice.js (which the sim
    // account and rewind.js scoring both use): $0.0035/share, a $0.35
    // floor per order, and a 1%-of-trade-value ceiling. Duplicated here
    // (rather than loading practice.js, which wires up a whole separate
    // paper-trading page's worth of DOM listeners) so "max shares" and
    // "risk amount" reflect what a fill would really cost, not a gross
    // number that ignores fees entirely.
    // ibkrTieredCommission() + IBKR_PER_SHARE/IBKR_MIN_PER_ORDER/
    // IBKR_MAX_PCT_OF_TRADE_VALUE now in utils.js (loads first on every page).

    // These 4 settings used to live only in this browser's localStorage.
    // Every setter below now also mirrors its value to Supabase
    // (user_kv, via KV in auth.js) so a wiped cache or a new device
    // doesn't reset them. On load, a synced value (if any) wins and
    // overwrites both the in-memory var and localStorage; otherwise
    // whatever's local right now is pushed up as the seed.
    if (window.KV) {
      window.KV.sync(LS_KEYS.riskPct, (v) => { if (isFinite(v)) { riskPct = v; localStorage.setItem(LS_KEYS.riskPct, String(v)); refreshControlsAndCalc(); } });
      window.KV.sync(LS_KEYS.stopMode, (v) => { if (typeof v === "string") { stopMode = v; localStorage.setItem(LS_KEYS.stopMode, v); refreshControlsAndCalc(); } });
      window.KV.sync(LS_KEYS.stopPct, (v) => { if (isFinite(v)) { stopPct = v; localStorage.setItem(LS_KEYS.stopPct, String(v)); refreshControlsAndCalc(); } });
      window.KV.sync(LS_KEYS.startingBalance, (v) => { if (isFinite(v) && v > 0) { startingBalance = v; localStorage.setItem(LS_KEYS.startingBalance, String(v)); refreshControlsAndCalc(); } });
      window.KV.sync(LS_KEYS.winRate, (v) => { if (isFinite(v) && v > 0 && v < 100) { winRate = v; localStorage.setItem(LS_KEYS.winRate, String(v)); refreshControlsAndCalc(); } });
    }
    // Re-paints the chip/button active states + balance display + result
    // after a synced value patches one of the vars above post-render.
    function refreshControlsAndCalc() {
      riskChips.forEach((c) => c.classList.toggle("active", parseFloat(c.dataset.risk) === riskPct));
      stopModeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === stopMode));
      stopChips.forEach((c) => c.classList.toggle("active", parseFloat(c.dataset.stoppct) === stopPct));
      winRateChips.forEach((c) => c.classList.toggle("active", parseFloat(c.dataset.winrate) === winRate));
      stopPctChipsWrap.style.display = stopMode === "pct" ? "flex" : "none";
      stopPriceWrap.style.display = stopMode === "price" ? "flex" : "none";
      renderBalance();
      calculate();
    }

    function parseNumber(str) {
      if (!str) return NaN;
      const cleaned = String(str).replace(/[^0-9.\-]/g, "");
      return cleaned === "" ? NaN : parseFloat(cleaned);
    }
    // fmtUsd() now in utils.js (loads first on every page). NOTE: canonical
    // fmtUsd() adds an isFinite() guard this copy lacked and uses "en-US"
    // explicitly instead of the browser-default locale; every call site
    // here already isFinite()-checked before calling, so this is not a
    // behavior change.
    function currentBalance() {
      return startingBalance + latestEquityAfter;
    }
    function renderBalance(skipInputField) {
      balanceDisplay.textContent = fmtUsd(currentBalance());
      balanceSub.textContent = latestEquityAfter
        ? `${fmtUsd(startingBalance)} start ${latestEquityAfter >= 0 ? "+" : "\u2212"} ${fmtUsd(Math.abs(latestEquityAfter))} P&L`
        : "no logged trades yet";
      // Skipped while the balance field itself is focused/being typed into --
      // see setStartingBalance() below. Re-stamping a formatted "$25,000.00"
      // into the field on every keystroke was yanking the cursor to the end
      // and making it impossible to type a new number.
      if (!skipInputField) startingBalanceEl.value = fmtUsd(startingBalance);
      balanceChips.forEach((c) => c.classList.toggle("active", parseFloat(c.dataset.balance) === startingBalance));
    }

    // --- Risk % chips ---
    const riskChips = Array.from(document.querySelectorAll("#calc-risk-chips .calc-chip"));
    function setRiskPct(v) {
      riskPct = v;
      localStorage.setItem(LS_KEYS.riskPct, String(v));
      if (window.KV) window.KV.set(LS_KEYS.riskPct, v);
      riskChips.forEach((c) => c.classList.toggle("active", parseFloat(c.dataset.risk) === v));
      calculate();
    }
    riskChips.forEach((c) => c.addEventListener("click", () => setRiskPct(parseFloat(c.dataset.risk))));

    // --- Stop mode toggle (percent distance vs exact price) ---
    const stopModeBtns = Array.from(document.querySelectorAll("#calc-stop-mode button"));
    function setStopMode(mode) {
      stopMode = mode;
      localStorage.setItem(LS_KEYS.stopMode, mode);
      if (window.KV) window.KV.set(LS_KEYS.stopMode, mode);
      stopModeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
      stopPctChipsWrap.style.display = mode === "pct" ? "flex" : "none";
      stopPriceWrap.style.display = mode === "price" ? "flex" : "none";
      calculate();
    }
    stopModeBtns.forEach((b) => b.addEventListener("click", () => setStopMode(b.dataset.mode)));

    // --- Stop % chips ---
    const stopChips = Array.from(document.querySelectorAll("#calc-stop-pct-chips .calc-chip"));
    function setStopPct(v) {
      stopPct = v;
      localStorage.setItem(LS_KEYS.stopPct, String(v));
      if (window.KV) window.KV.set(LS_KEYS.stopPct, v);
      stopChips.forEach((c) => c.classList.toggle("active", parseFloat(c.dataset.stoppct) === v));
      calculate();
    }
    stopChips.forEach((c) => c.addEventListener("click", () => setStopPct(parseFloat(c.dataset.stoppct))));

    // --- Win rate chips (assumption used for expected value only) ---
    const winRateChips = Array.from(document.querySelectorAll("#calc-winrate-chips .calc-chip"));
    function setWinRate(v) {
      winRate = v;
      localStorage.setItem(LS_KEYS.winRate, String(v));
      if (window.KV) window.KV.set(LS_KEYS.winRate, v);
      winRateChips.forEach((c) => c.classList.toggle("active", parseFloat(c.dataset.winrate) === v));
      calculate();
    }
    winRateChips.forEach((c) => c.addEventListener("click", () => setWinRate(parseFloat(c.dataset.winrate))));

    // --- Account size: preset chips + custom edit ---
    const balanceChips = Array.from(document.querySelectorAll("#calc-balance-chips .calc-chip"));
    function setStartingBalance(v, skipInputField) {
      startingBalance = v;
      localStorage.setItem(LS_KEYS.startingBalance, String(v));
      if (window.KV) window.KV.set(LS_KEYS.startingBalance, v);
      renderBalance(skipInputField);
      calculate();
    }
    balanceChips.forEach((c) => c.addEventListener("click", () => setStartingBalance(parseFloat(c.dataset.balance))));

    balanceEditBtn.addEventListener("click", () => {
      const showing = balanceEditWrap.style.display !== "none";
      balanceEditWrap.style.display = showing ? "none" : "flex";
      balanceEditBtn.textContent = showing ? "edit starting balance" : "done";
      if (!showing) startingBalanceEl.focus();
    });
    // While typing, update the underlying number (so live calc results stay
    // in sync) but leave the field's own text alone -- reformatting it mid-
    // keystroke was what broke typing. Only snap it to "$25,000.00" once the
    // person is done editing (blur or Enter).
    startingBalanceEl.addEventListener("input", () => {
      const v = parseNumber(startingBalanceEl.value);
      if (isFinite(v) && v > 0) setStartingBalance(v, true);
    });
    startingBalanceEl.addEventListener("blur", () => {
      renderBalance();
    });
    startingBalanceEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") startingBalanceEl.blur();
    });

    // --- Steppers (nudge entry/stop by 1 cent, or 10 cents with shift) ---
    document.querySelectorAll(".calc-stepper").forEach((wrap) => {
      const target = document.getElementById(wrap.dataset.target);
      wrap.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const dir = parseFloat(btn.dataset.dir);
          const cur = parseNumber(target.value) || 0;
          const step = e.shiftKey ? 0.10 : 0.01;
          const next = Math.max(0, cur + dir * step);
          target.value = "$" + next.toFixed(2);
          calculate();
        });
      });
    });

    // Total dollar loss if stopped out at `shares`, including the entry
    // fill's commission AND the commission on the losing exit -- this is
    // what actually leaves the account, not just shares * per-share-risk.
    function riskCostForShares(shares, entry, stop) {
      if (!(shares > 0)) return 0;
      const perShareRisk = Math.abs(entry - stop);
      return perShareRisk * shares + ibkrTieredCommission(shares, entry) + ibkrTieredCommission(shares, stop);
    }
    // Total cash the entry fill itself ties up, including its commission.
    function cashCostForShares(shares, entry) {
      if (!(shares > 0)) return 0;
      return shares * entry + ibkrTieredCommission(shares, entry);
    }

    function calculate() {
      const account = currentBalance();
      const entry = parseNumber(entryEl.value);
      let stop;

      if (stopMode === "pct") {
        stop = isFinite(entry) ? entry * (1 - stopPct / 100) : NaN;
        stopComputedEl.textContent = isFinite(stop)
          ? `= stop at ${fmtUsd(stop)} (${stopPct}% below entry)`
          : "enter an entry price to compute the stop";
      } else {
        stop = parseNumber(stopEl.value);
        stopComputedEl.textContent = "";
      }

      const perShareRisk = (isFinite(entry) && isFinite(stop)) ? Math.abs(entry - stop) : NaN;
      const riskAmount = account * (riskPct / 100);

      riskAmountEl.textContent = fmtUsd(riskAmount);
      riskAmountSubEl.textContent = `${riskPct}% of ${fmtUsd(account)}`;
      perShareRiskEl.textContent = isFinite(perShareRisk) ? fmtUsd(perShareRisk) : "\u2014";

      // Losing-streak reality check: what N losses in a row at this risk %
      // does to the account, compounding down each time (a real losing
      // streak shrinks the account, so each next loss is % of a smaller
      // number) -- this is the number that actually explains why risk %
      // per trade matters, independent of any specific entry/stop.
      [[3, streak3El], [5, streak5El], [10, streak10El]].forEach(([n, el]) => {
        const remainingPct = Math.pow(1 - riskPct / 100, n);
        const lossPct = (1 - remainingPct) * 100;
        const lossDollars = account * (1 - remainingPct);
        el.textContent = `\u2212${fmtUsd(lossDollars)} (\u2212${lossPct.toFixed(1)}%)`;
      });

      if (!isFinite(perShareRisk) || perShareRisk <= 0) {
        maxSharesEl.textContent = "\u2014";
        positionCostEl.textContent = "\u2014";
        positionPctEl.textContent = "\u2014";
        positionCostStat.classList.remove("warn");
        commissionEl.textContent = "\u2014";
        netRiskEl.textContent = "\u2014";
        netRiskSubEl.textContent = "\u2014";
        r1El.textContent = "\u2014";
        r2El.textContent = "\u2014";
        r3El.textContent = "\u2014";
        [r1RowEl, r2RowEl, r3RowEl].forEach((row) => { delete row.dataset.price; });
        rTargetRowEl.style.display = "none";
        qualityEmptyEl.style.display = "";
        qualityGridEl.style.display = "none";
        qualityEmptyEl.textContent = "enter an entry price and a stop to see position size and reward";
        summaryEl.innerHTML = "Enter an entry price and a stop on the left to see how many shares to buy.";
        return;
      }

      // Naive risk-only cap, ignoring commission and cash -- true max
      // shares (with fees + cash both applied) can only be <= this, so
      // it's a safe upper bound to binary-search down from. Cost as a
      // function of share count is monotonic non-decreasing (more shares
      // never costs less), so a plain binary search converges correctly.
      const riskOnlyMaxShares = Math.floor(riskAmount / perShareRisk);
      function feasible(shares) {
        return riskCostForShares(shares, entry, stop) <= riskAmount + 1e-6
          && cashCostForShares(shares, entry) <= account + 1e-6;
      }
      let lo = 0, hi = Math.max(0, riskOnlyMaxShares);
      while (lo < hi) {
        const mid = Math.ceil((lo + hi + 1) / 2);
        if (feasible(mid)) lo = mid; else hi = mid - 1;
      }
      const maxShares = lo;

      // Which constraint is actually binding, for the "capped by..." label.
      const nextCashOk = cashCostForShares(maxShares + 1, entry) <= account + 1e-6;
      const cashLimited = !nextCashOk;

      maxSharesEl.textContent = maxShares.toLocaleString();

      const entryCommission = ibkrTieredCommission(maxShares, entry);
      const stopCommission = ibkrTieredCommission(maxShares, stop);
      const roundTripCommission = entryCommission + stopCommission;
      const netRisk = riskCostForShares(maxShares, entry, stop);
      const positionCost = cashCostForShares(maxShares, entry);

      positionCostEl.textContent = isFinite(positionCost) ? fmtUsd(positionCost) : "\u2014";
      positionCostStat.classList.toggle("warn", cashLimited && maxShares > 0);
      positionPctEl.textContent = isFinite(positionCost) && account > 0
        ? (cashLimited ? "capped by account size" : `${((positionCost / account) * 100).toFixed(1)}% of account`)
        : "\u2014";

      commissionEl.textContent = maxShares > 0 ? fmtUsd(roundTripCommission) : "\u2014";
      netRiskEl.textContent = maxShares > 0 ? fmtUsd(netRisk) : "\u2014";
      netRiskSubEl.textContent = maxShares > 0
        ? `vs. ${fmtUsd(riskAmount)} budget`
        : "\u2014";

      // Plain-English takeaway -- the one sentence someone should actually
      // walk away with, instead of having to mentally assemble it from the
      // stat grid below. Overwritten again further down once a target is
      // entered, with the reward/EV added on.
      summaryEl.innerHTML = maxShares > 0
        ? `Buy up to <b>${maxShares.toLocaleString()} shares</b>. If you're stopped out, you lose <b class="down">${fmtUsd(netRisk)}</b> \u2014 ${riskPct}% of your ${fmtUsd(account)} account.`
        : `Your account can't support even 1 share at this risk/stop combo \u2014 try a wider risk % or a tighter stop.`;

      // R-multiple price levels (long: above entry; short: below entry),
      // each clickable to fill the target field with that exit price.
      const direction = stop < entry ? "long" : (stop > entry ? "short" : null);
      const rSign = direction === "short" ? -1 : 1;
      [[1, r1El, r1RowEl], [2, r2El, r2RowEl], [3, r3El, r3RowEl]].forEach(([mult, el, row]) => {
        const price = entry + rSign * perShareRisk * mult;
        el.textContent = `${fmtUsd(price)} (${fmtUsd(riskAmount * mult)})`;
        row.dataset.price = price.toFixed(4);
      });

      // --- Target price / reward / risk:reward / expected value ---
      const target = parseNumber(targetEl.value);
      const hasTarget = isFinite(target) && direction !== null;
      const rewardPerShare = hasTarget
        ? (direction === "long" ? target - entry : entry - target)
        : NaN;

      if (!hasTarget || !(rewardPerShare > 0) || maxShares <= 0) {
        rTargetRowEl.style.display = "none";
        qualityEmptyEl.style.display = "";
        qualityGridEl.style.display = "none";
        qualityEmptyEl.textContent = (hasTarget && !(rewardPerShare > 0))
          ? `target should be ${direction === "long" ? "above" : "below"} entry for this ${direction}`
          : "enter a target price to see risk/reward and expected value";
        return;
      }

      const targetCommission = ibkrTieredCommission(maxShares, target);
      const netReward = rewardPerShare * maxShares - entryCommission - targetCommission;
      const targetR = rewardPerShare / perShareRisk;

      rTargetRowEl.style.display = "";
      rTargetEl.textContent = `${fmtUsd(target)} (${targetR.toFixed(2)}R, ${netReward >= 0 ? "+" : "\u2212"}${fmtUsd(Math.abs(netReward))} net)`;

      qualityEmptyEl.style.display = "none";
      qualityGridEl.style.display = "";

      netRewardEl.textContent = fmtUsd(Math.abs(netReward));
      netRewardEl.classList.toggle("up", netReward >= 0);
      netRewardEl.classList.toggle("down", netReward < 0);

      const rrRatio = netRisk > 0 ? netReward / netRisk : NaN;
      rrRatioEl.textContent = isFinite(rrRatio) ? `${rrRatio.toFixed(2)}R` : "\u2014";

      // Minimum win rate needed to break even long-run, from net
      // risk/reward alone (independent of the win-rate assumption below).
      const breakeven = (netRisk + netReward) > 0 ? (netRisk / (netRisk + netReward)) * 100 : NaN;
      breakevenEl.textContent = isFinite(breakeven) ? `${breakeven.toFixed(1)}%` : "\u2014";

      const ev = (winRate / 100) * netReward - (1 - winRate / 100) * netRisk;
      evEl.textContent = (ev >= 0 ? "+" : "\u2212") + fmtUsd(Math.abs(ev));
      evEl.classList.toggle("up", ev >= 0);
      evEl.classList.toggle("down", ev < 0);
      evSubEl.textContent = `at ${winRate}% assumed win rate`;

      summaryEl.innerHTML = `Buy up to <b>${maxShares.toLocaleString()} shares</b>. If you're stopped out, you lose <b class="down">${fmtUsd(netRisk)}</b> (${riskPct}% of your account) \u2014 if you hit your target instead, you make <b class="up">${fmtUsd(Math.abs(netReward))}</b>, a <b>${rrRatio.toFixed(2)}R</b> trade that only needs to win <b>${breakeven.toFixed(0)}%</b> of the time to break even.`;
    }

    [entryEl, stopEl, targetEl].forEach((el) => {
      el.addEventListener("input", calculate);
      el.addEventListener("blur", calculate);
    });

    // --- R-level rows: tap to fill the target price with that level's price ---
    [[r1RowEl, 1], [r2RowEl, 2], [r3RowEl, 3]].forEach(([row, mult]) => {
      row.addEventListener("click", () => {
        const price = row.dataset.price;
        if (!price) return;
        targetEl.value = price;
        calculate();
      });
    });

    // --- Init from saved prefs ---
    riskChips.forEach((c) => c.classList.toggle("active", parseFloat(c.dataset.risk) === riskPct));
    if (!riskChips.some((c) => parseFloat(c.dataset.risk) === riskPct)) riskChips[2].classList.add("active");
    stopChips.forEach((c) => c.classList.toggle("active", parseFloat(c.dataset.stoppct) === stopPct));
    winRateChips.forEach((c) => c.classList.toggle("active", parseFloat(c.dataset.winrate) === winRate));
    setStopMode(stopMode);
    renderBalance();
    calculate();

    // --- Pull latest equity + recent symbols from the journal so account
    // size and quick-fill reference prices don't need to be typed in. ---
    window.fetchTradesIndex()
      .then((trades) => {
        if (!Array.isArray(trades) || trades.length === 0) return;
        const last = trades[trades.length - 1];
        if (last && isFinite(last.equity_after)) {
          latestEquityAfter = last.equity_after;
          renderBalance();
          calculate();
        }
        // Your actual win rate, so the "Est. win rate" assumption isn't a
        // number pulled out of thin air -- shown as a badge either way,
        // and used as the starting default (instead of the hardcoded 50%)
        // for anyone who hasn't already picked their own win-rate chip.
        const wins = trades.filter((t) => t.win).length;
        const actualWinRate = (wins / trades.length) * 100;
        winRateActualEl.style.display = "block";
        winRateActualEl.innerHTML = `Your actual win rate across ${trades.length} logged trade${trades.length === 1 ? "" : "s"}: <b>${actualWinRate.toFixed(0)}%</b> — <button type="button" id="calc-use-actual-winrate" style="all:unset;cursor:pointer;color:var(--primary);text-decoration:underline;">use this</button>`;
        document.getElementById("calc-use-actual-winrate").addEventListener("click", () => {
          winRateChips.forEach((c) => c.classList.remove("active"));
          setWinRate(Math.round(actualWinRate));
        });
        if (!localStorage.getItem(LS_KEYS.winRate)) {
          winRateChips.forEach((c) => c.classList.remove("active"));
          setWinRate(Math.round(actualWinRate));
        }
        const seen = new Set();
        const recent = [];
        for (let i = trades.length - 1; i >= 0 && recent.length < 6; i--) {
          const t = trades[i];
          if (!t.symbol || seen.has(t.symbol)) continue;
          seen.add(t.symbol);
          recent.push(t);
        }
        if (recent.length) {
          symbolRow.style.display = "flex";
          symbolListEl.innerHTML = "";
          recent.forEach((t) => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "calc-symbol-chip";
            chip.innerHTML = `<span class="sym">${escapeHtml(t.symbol)}</span><span class="px">last ${fmtUsd(t.entry_price)}</span>`;
            chip.addEventListener("click", () => {
              entryEl.value = fmtUsd(t.entry_price);
              calculate();
            });
            symbolListEl.appendChild(chip);
          });
        }
      })
      .catch(() => { /* journal not reachable -- calculator still works standalone */ });
  })();
