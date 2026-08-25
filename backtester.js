// backtester.js
// Drives the Backtester tab: builds a strategy config from the form, starts
// a backtest job on chart_service.py (/backtest/start), polls it to
// completion (/backtest/status/<id>), and renders stats + an equity curve +
// a trades table. Also lists/reloads/deletes past runs (/backtest/history).
//
// Talks directly to chart_service.py's ngrok URL (window.CHART_SERVICE_URL
// in config.js) -- not through n8n, since this is a start-job/poll-status
// flow rather than one request/response.
(function () {
  "use strict";

  const API = () => (window.CHART_SERVICE_URL || "").replace(/\/+$/, "");
  const FETCH_HEADERS = {
    "Content-Type": "application/json",
    // Free-tier ngrok shows an HTML "you're about to visit..." interstitial
    // to plain browser requests unless this header is present -- without it
    // fetch() would get that HTML back instead of JSON and fail to parse.
    "ngrok-skip-browser-warning": "true",
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtMoney(v) {
    if (typeof v !== "number") return "—";
    const sign = v >= 0 ? "+" : "-";
    return sign + "$" + Math.abs(v).toFixed(2);
  }
  function fmtPct(v) {
    return typeof v === "number" ? v.toFixed(1) + "%" : "—";
  }
  function fmtR(v) {
    return typeof v === "number" ? v.toFixed(2) + "R" : "—";
  }
  function placeholderNotSet() {
    return !API() || API().includes("YOUR-NGROK-SUBDOMAIN");
  }

  const els = {
    apiPill: document.getElementById("bt-api-pill"),
    label: document.getElementById("bt-label"),
    start: document.getElementById("bt-start"),
    end: document.getElementById("bt-end"),
    topN: document.getElementById("bt-top-n"),
    minPrice: document.getElementById("bt-min-price"),
    maxPrice: document.getElementById("bt-max-price"),
    minDollarVolume: document.getElementById("bt-min-dollar-volume"),
    minGapPct: document.getElementById("bt-min-gap-pct"),
    positionSize: document.getElementById("bt-position-size"),
    sessionStart: document.getElementById("bt-session-start"),
    flattenTime: document.getElementById("bt-flatten-time"),
    notes: document.getElementById("bt-notes"),
    entryMode: document.getElementById("bt-entry-mode"),
    orbMinutes: document.getElementById("bt-orb-minutes"),
    entryAfterOrb: document.getElementById("bt-entry-after-orb"),
    donchianLookback: document.getElementById("bt-donchian-lookback"),
    stopMode: document.getElementById("bt-stop-mode"),
    fixedStopCents: document.getElementById("bt-fixed-stop-cents"),
    fixedStopPct: document.getElementById("bt-fixed-stop-pct"),
    atrPeriod: document.getElementById("bt-atr-period"),
    atrMult: document.getElementById("bt-atr-mult"),
    breakevenAfterCents: document.getElementById("bt-breakeven-after-cents"),
    targetR: document.getElementById("bt-target-r"),
    timeStopMinutes: document.getElementById("bt-time-stop-minutes"),
    timeStopMinGainCents: document.getElementById("bt-time-stop-min-gain-cents"),
    givebackCents: document.getElementById("bt-giveback-cents"),
    givebackPct: document.getElementById("bt-giveback-pct"),
    givebackArmCents: document.getElementById("bt-giveback-arm-cents"),
    stallExit: document.getElementById("bt-stall-exit"),
    runBtn: document.getElementById("bt-run-btn"),
    cancelBtn: document.getElementById("bt-cancel-btn"),
    runStatus: document.getElementById("bt-run-status"),
    progressBox: document.getElementById("bt-progress-box"),
    progressFill: document.getElementById("bt-progress-fill"),
    progressLabel: document.getElementById("bt-progress-label"),
    results: document.getElementById("bt-results"),
    history: document.getElementById("bt-history"),
  };

  // Default date range: trailing 14 calendar days, ending yesterday (today's
  // session may not be closed yet).
  (function seedDates() {
    const end = new Date();
    end.setDate(end.getDate() - 1);
    const start = new Date(end);
    start.setDate(start.getDate() - 14);
    const iso = (d) => d.toISOString().slice(0, 10);
    els.end.value = iso(end);
    els.start.value = iso(start);
  })();

  function checkApi() {
    if (placeholderNotSet()) {
      els.apiPill.textContent = "API not configured";
      els.apiPill.title = "Set window.CHART_SERVICE_URL in config.js to your ngrok URL";
      return;
    }
    fetch(`${API()}/backtest/defaults`, { headers: FETCH_HEADERS })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(() => {
        els.apiPill.textContent = "API connected";
        els.apiPill.title = API();
      })
      .catch(() => {
        els.apiPill.textContent = "API unreachable";
        els.apiPill.title = "Couldn't reach " + API() + " -- is chart_service.py / ngrok running?";
      });
  }
  checkApi();

  function buildPayload() {
    return {
      label: els.label.value.trim(),
      start: els.start.value,
      end: els.end.value,
      top_n: Number(els.topN.value) || 5,
      min_price: Number(els.minPrice.value) || 0,
      max_price: Number(els.maxPrice.value) || 0,
      min_dollar_volume: Number(els.minDollarVolume.value) || 0,
      min_gap_pct: Number(els.minGapPct.value) || 0,
      position_size: Number(els.positionSize.value) || 0,
      session_start: els.sessionStart.value || "09:30",
      flatten_time: els.flattenTime.value || "15:55",
      // Not read or acted on by the engine -- just carried through to
      // /backtest/start's body, which chart_service.py saves verbatim as
      // this run's `params` in backtest_history.json, so anything the AI
      // (or you) noted but couldn't map to a real field is at least kept
      // on record instead of silently vanishing.
      notes: els.notes ? els.notes.value.trim() : "",

      entry_mode: els.entryMode.value,
      orb_minutes: Number(els.orbMinutes.value) || 5,
      entry_after_orb: !!els.entryAfterOrb.checked,
      donchian_lookback: Number(els.donchianLookback.value) || 10,

      stop_mode: els.stopMode.value,
      fixed_stop_cents: Number(els.fixedStopCents.value) || 0,
      fixed_stop_pct: Number(els.fixedStopPct.value) || 0,
      atr_period: Number(els.atrPeriod.value) || 14,
      atr_mult: Number(els.atrMult.value) || 0,
      breakeven_after_cents: Number(els.breakevenAfterCents.value) || 0,

      target_r: Number(els.targetR.value) || 0,
      time_stop_minutes: Number(els.timeStopMinutes.value) || 0,
      time_stop_min_gain_cents: Number(els.timeStopMinGainCents.value) || 0,
      giveback_cents: Number(els.givebackCents.value) || 0,
      giveback_pct: Number(els.givebackPct.value) || 0,
      giveback_arm_cents: Number(els.givebackArmCents.value) || 0,
      stall_exit: !!els.stallExit.checked,
    };
  }

  function applyPayload(p) {
    if (!p) return;
    const set = (el, v) => { if (el && v !== undefined && v !== null) el.value = v; };
    const setChk = (el, v) => { if (el && v !== undefined && v !== null) el.checked = !!v; };
    set(els.label, p.label);
    set(els.start, p.start);
    set(els.end, p.end);
    set(els.topN, p.top_n);
    set(els.minPrice, p.min_price);
    set(els.maxPrice, p.max_price);
    set(els.minDollarVolume, p.min_dollar_volume);
    set(els.minGapPct, p.min_gap_pct);
    set(els.positionSize, p.position_size);
    set(els.sessionStart, p.session_start);
    set(els.flattenTime, p.flatten_time);
    set(els.notes, p.notes);
    set(els.entryMode, p.entry_mode);
    set(els.orbMinutes, p.orb_minutes);
    setChk(els.entryAfterOrb, p.entry_after_orb !== false);
    set(els.donchianLookback, p.donchian_lookback);
    set(els.stopMode, p.stop_mode);
    set(els.fixedStopCents, p.fixed_stop_cents);
    set(els.fixedStopPct, p.fixed_stop_pct);
    set(els.atrPeriod, p.atr_period);
    set(els.atrMult, p.atr_mult);
    set(els.breakevenAfterCents, p.breakeven_after_cents);
    set(els.targetR, p.target_r);
    set(els.timeStopMinutes, p.time_stop_minutes);
    set(els.timeStopMinGainCents, p.time_stop_min_gain_cents);
    set(els.givebackCents, p.giveback_cents);
    set(els.givebackPct, p.giveback_pct);
    set(els.givebackArmCents, p.giveback_arm_cents);
    setChk(els.stallExit, p.stall_exit);
    // Note: no scroll call here on purpose. flashFormSections() (called
    // right after this by backtester-ai.js) does the scrolling -- having
    // both fire in the same tick made the page jump to two different
    // targets and land on whichever won the race, which looked like the
    // just-filled form had vanished.
  }

  // Exposed so backtester-ai.js (the "Configure with AI" panel) can read
  // the current form state and write a finished config back into it
  // without duplicating every field mapping above. Nothing else on this
  // page depends on this global.
  window.BacktesterForm = {
    build: buildPayload,
    apply: applyPayload,
    runBtn: () => els.runBtn,
  };

  // Persist the running job's id (+ which API it's on) so a page refresh
  // -- or just closing the tab and coming back -- doesn't lose track of a
  // backtest that's still going server-side. A multi-day scan can take a
  // long time; the browser tab is just a viewer into it, not what's
  // actually running it.
  const JOB_STORAGE_KEY = "bt_active_job";
  let running = false;
  let pollTimer = null;
  let currentJobId = null;

  function saveActiveJob(jobId) {
    try { localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify({ jobId, api: API() })); } catch (e) { /* ignore */ }
  }
  function clearActiveJob() {
    try { localStorage.removeItem(JOB_STORAGE_KEY); } catch (e) { /* ignore */ }
  }
  function loadActiveJob() {
    try {
      const raw = localStorage.getItem(JOB_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && parsed.jobId && parsed.api === API() ? parsed.jobId : null;
    } catch (e) { return null; }
  }

  els.runBtn.addEventListener("click", () => {
    if (running) return;
    if (placeholderNotSet()) {
      els.runStatus.textContent = "Set window.CHART_SERVICE_URL in config.js to your ngrok URL first.";
      return;
    }
    if (!els.start.value || !els.end.value) {
      els.runStatus.textContent = "Pick a start and end date.";
      return;
    }

    startRunningUi();
    els.results.innerHTML = "";

    fetch(`${API()}/backtest/start`, {
      method: "POST",
      headers: FETCH_HEADERS,
      body: JSON.stringify(buildPayload()),
    })
      .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || "HTTP " + r.status); return j; }))
      .then((j) => { saveActiveJob(j.job_id); pollJob(j.job_id); })
      .catch((err) => {
        finishRun();
        els.runStatus.textContent = "Couldn't start backtest: " + err.message;
      });
  });

  if (els.cancelBtn) {
    els.cancelBtn.addEventListener("click", () => {
      if (!currentJobId) return;
      els.cancelBtn.disabled = true;
      els.cancelBtn.textContent = "Cancelling…";
      fetch(`${API()}/backtest/cancel/${currentJobId}`, { method: "POST", headers: FETCH_HEADERS })
        .catch(() => { /* status poll will surface any real problem */ });
    });
  }

  function startRunningUi() {
    running = true;
    els.runBtn.disabled = true;
    els.runBtn.textContent = "Starting…";
    els.runStatus.textContent = "";
    if (els.cancelBtn) { els.cancelBtn.style.display = ""; els.cancelBtn.disabled = false; els.cancelBtn.textContent = "Cancel"; }
    els.progressBox.style.display = "";
    els.progressFill.style.width = "0%";
    els.progressLabel.textContent = "Scanning for gappers…";
  }

  function pollJob(jobId) {
    currentJobId = jobId;
    els.runBtn.textContent = "Running…";
    clearTimeout(pollTimer);
    const tick = () => {
      fetch(`${API()}/backtest/status/${jobId}`, { headers: FETCH_HEADERS })
        .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then((job) => {
          // A job in progress already carries partial trades/stats (updated
          // after every completed day) -- show them as they come in instead
          // of making the person wait for the whole range to finish before
          // seeing anything.
          if (job.stats && job.stats.num_trades) {
            renderResults(job.stats, job.trades || [], /*partial=*/ job.status === "running");
          }

          if (job.status === "running") {
            if (job.total) {
              const pct = Math.round((job.current / job.total) * 100);
              els.progressFill.style.width = pct + "%";
              els.progressLabel.textContent = `Day ${job.current}/${job.total}${job.day ? " — " + job.day : ""}`;
            }
            pollTimer = setTimeout(tick, 1200);
            return;
          }
          if (job.status === "error") {
            finishRun();
            els.runStatus.textContent = "Backtest failed: " + job.error;
            return;
          }
          if (job.status === "cancelled") {
            els.progressLabel.textContent = "Cancelled.";
            els.runStatus.textContent = `Cancelled — showing results through day ${job.current}/${job.total || "?"}.`;
            renderResults(job.stats, job.trades || [], false);
            finishRun();
            return;
          }
          // done
          els.progressFill.style.width = "100%";
          els.progressLabel.textContent = "Done.";
          renderResults(job.stats, job.trades || [], false);
          loadHistory();
          finishRun();
        })
        .catch((err) => {
          finishRun();
          els.runStatus.textContent = "Lost connection while polling: " + err.message;
        });
    };
    tick();
  }

  function finishRun() {
    running = false;
    currentJobId = null;
    clearActiveJob();
    els.runBtn.disabled = false;
    els.runBtn.textContent = "Run Backtest";
    if (els.cancelBtn) els.cancelBtn.style.display = "none";
    setTimeout(() => { els.progressBox.style.display = "none"; }, 800);
  }

  // On load, if a job was left running (refresh, tab reopened, etc.),
  // reattach to it instead of showing a blank "Run Backtest" button that
  // implies nothing is happening -- the job itself is untouched, only the
  // browser's polling loop was lost.
  (function resumeActiveJobIfAny() {
    const jobId = loadActiveJob();
    if (!jobId) return;
    fetch(`${API()}/backtest/status/${jobId}`, { headers: FETCH_HEADERS })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((job) => {
        if (job.status === "running") {
          startRunningUi();
          pollJob(jobId);
        } else {
          clearActiveJob();
        }
      })
      .catch(() => clearActiveJob());
  })();

  function renderResults(stats, trades, partial) {
    if (!stats || !stats.num_trades) {
      if (partial) return; // still running, just hasn't produced a trade yet -- don't flash an empty-state
      els.results.innerHTML = `<div class="empty-state">No trades matched this config over that date range — try loosening the filters or widening the dates.</div>`;
      return;
    }

    const partialBanner = partial
      ? `<div class="empty-state small" style="margin-bottom:14px;">Backtest still running — showing results through the last completed day. This updates as more days finish.</div>`
      : "";

    els.results.innerHTML = `
      ${partialBanner}
      <div class="stat-grid" style="margin-bottom:18px;">
        <div class="stat">
          <div class="label-row"><span class="label">Net P&amp;L</span></div>
          <div class="value ${stats.net_pnl_dollars >= 0 ? "up" : "down"}">${fmtMoney(stats.net_pnl_dollars)}</div>
        </div>
        <div class="stat">
          <div class="label-row"><span class="label">Win Rate</span></div>
          <div class="value">${fmtPct(stats.win_rate)}</div>
          <div class="sub-value">${stats.num_trades} trade${stats.num_trades === 1 ? "" : "s"}</div>
        </div>
        <div class="stat">
          <div class="label-row"><span class="label">Profit Factor</span></div>
          <div class="value">${stats.profit_factor != null ? stats.profit_factor.toFixed(2) : "—"}</div>
        </div>
        <div class="stat">
          <div class="label-row"><span class="label">Avg R</span></div>
          <div class="value ${stats.avg_r >= 0 ? "up" : "down"}">${fmtR(stats.avg_r)}</div>
        </div>
        <div class="stat">
          <div class="label-row"><span class="label">Max Drawdown</span></div>
          <div class="value down">-$${Number(stats.max_drawdown_dollars || 0).toFixed(2)}</div>
        </div>
        <div class="stat">
          <div class="label-row"><span class="label">Streaks (W/L)</span></div>
          <div class="value">${stats.longest_win_streak} / ${stats.longest_loss_streak}</div>
        </div>
      </div>

      <div class="panel-box" style="margin-bottom:18px;">
        <div class="panel-box-head"><span class="title">Equity Curve</span></div>
        <div id="bt-equity-chart" style="height:240px;"></div>
      </div>

      <div class="panel-box">
        <div class="panel-box-head"><span class="title">Trades (${trades.length})</span></div>
        <div style="overflow-x:auto;">
          <table class="data-table">
            <thead><tr>
              <th>Date</th><th>Symbol</th><th>Gap %</th><th>Entry</th><th>Entry $</th>
              <th>Exit</th><th>Exit $</th><th>Reason</th><th>Shares</th><th>P&amp;L $</th><th>R</th>
            </tr></thead>
            <tbody>${trades.map(tradeRow).join("")}</tbody>
          </table>
        </div>
      </div>
    `;

    renderEquityCurve(stats.equity_curve || []);
  }

  function tradeRow(t) {
    const pillClass = t.win ? "win" : "loss";
    return `<tr>
      <td>${escapeHtml(t.date)}</td>
      <td>${escapeHtml(t.symbol)}</td>
      <td>${Number(t.gap_pct).toFixed(1)}%</td>
      <td>${escapeHtml(t.entry_time)}</td>
      <td>$${Number(t.entry_price).toFixed(2)}</td>
      <td>${escapeHtml(t.exit_time)}</td>
      <td>$${Number(t.exit_price).toFixed(2)}</td>
      <td>${escapeHtml(t.exit_reason)}</td>
      <td>${t.shares}</td>
      <td><span class="pill ${pillClass}">${fmtMoney(t.pnl_dollars)}</span></td>
      <td>${fmtR(t.r_multiple)}</td>
    </tr>`;
  }

  function renderEquityCurve(curve) {
    const el = document.getElementById("bt-equity-chart");
    if (!el || !window.LightweightCharts) return;
    const chart = LightweightCharts.createChart(el, {
      width: el.clientWidth,
      height: 240,
      layout: { background: { color: "transparent" }, textColor: "#8b8fa3" },
      grid: { vertLines: { color: "#1b1e26" }, horzLines: { color: "#1b1e26" } },
      rightPriceScale: { borderColor: "#262a34" },
      timeScale: { borderColor: "#262a34" },
    });
    const series = chart.addAreaSeries({
      lineColor: "#5b93f0", topColor: "rgba(91,147,240,0.28)", bottomColor: "rgba(91,147,240,0.02)", lineWidth: 2,
    });
    // Collapse same-day trades to that day's final equity value --
    // lightweight-charts needs one strictly-increasing time key per point.
    const byDate = new Map();
    for (const point of curve) byDate.set(point.date, point.equity);
    const data = Array.from(byDate.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([time, value]) => ({ time, value }));
    series.setData(data);
    chart.timeScale().fitContent();
    window.addEventListener("resize", () => chart.applyOptions({ width: el.clientWidth }));
  }

  function loadHistory() {
    if (placeholderNotSet()) {
      els.history.innerHTML = `<div class="empty-state small">Set window.CHART_SERVICE_URL in config.js to see past runs.</div>`;
      return;
    }
    fetch(`${API()}/backtest/history`, { headers: FETCH_HEADERS })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((entries) => {
        if (!entries.length) {
          els.history.innerHTML = `<div class="empty-state small">No runs yet — configure a strategy above and hit Run Backtest.</div>`;
          return;
        }
        els.history.innerHTML = `<div class="playbook-grid">${entries.map(historyCard).join("")}</div>`;
        entries.forEach((entry) => {
          const card = document.getElementById(`bt-run-${entry.id}`);
          if (!card) return;
          card.addEventListener("click", (e) => {
            if (e.target.closest(".run-card-delete")) return;
            applyPayload(entry.params);
          });
          const delBtn = card.querySelector(".run-card-delete");
          if (delBtn) {
            delBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              deleteHistoryEntry(entry.id);
            });
          }
        });
      })
      .catch((err) => {
        els.history.innerHTML = `<div class="empty-state small">Couldn't load past runs (${escapeHtml(err.message)}).</div>`;
      });
  }

  function historyCard(entry) {
    const s = entry.stats || {};
    const pnlClass = (s.net_pnl_dollars || 0) >= 0 ? "up" : "down";
    return `
      <div class="run-card" id="bt-run-${entry.id}" title="Click to load these settings back into the form">
        <div class="run-card-head">
          <span class="run-card-title">${escapeHtml(entry.label || "(untitled run)")}</span>
          <button class="run-card-delete" title="Delete this run" aria-label="Delete this run">&times;</button>
        </div>
        <div class="run-card-date">${escapeHtml((entry.params && entry.params.start) || "")} → ${escapeHtml((entry.params && entry.params.end) || "")}</div>
        ${entry.params && entry.params.notes ? `<div class="run-card-date" title="${escapeHtml(entry.params.notes)}" style="margin-top:4px; font-style:italic;">📝 ${escapeHtml(entry.params.notes.slice(0, 80))}${entry.params.notes.length > 80 ? "…" : ""}</div>` : ""}
        <div class="run-card-stats" style="margin-top:10px;">
          <div><div class="pb-label">Net P&amp;L</div><div class="pb-value ${pnlClass === "up" ? "" : ""}" style="color:${pnlClass === "up" ? "var(--green)" : "var(--red)"}">${fmtMoney(s.net_pnl_dollars)}</div></div>
          <div><div class="pb-label">Win Rate</div><div class="pb-value">${fmtPct(s.win_rate)}</div></div>
          <div><div class="pb-label">Trades</div><div class="pb-value">${s.num_trades != null ? s.num_trades : "—"}</div></div>
          <div><div class="pb-label">Avg R</div><div class="pb-value">${fmtR(s.avg_r)}</div></div>
        </div>
      </div>`;
  }

  function deleteHistoryEntry(id) {
    fetch(`${API()}/backtest/history/${id}`, { method: "DELETE", headers: FETCH_HEADERS })
      .then(() => loadHistory())
      .catch((err) => { els.runStatus.textContent = "Couldn't delete run: " + err.message; });
  }

  loadHistory();
})();
