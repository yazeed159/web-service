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
    includeCommissions: document.getElementById("bt-include-commissions"),
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
      include_commissions: els.includeCommissions ? !!els.includeCommissions.checked : true,
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
    setChk(els.includeCommissions, p.include_commissions !== false);
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
    // Drives a run straight from a config object (e.g. the "Configure with
    // AI" chat's resolved draft) instead of buildPayload()'s DOM read.
    // Also mirrors the payload into the form via applyPayload() so what's
    // on screen matches what actually ran, but that's just for display --
    // the fetch body below is `payload` itself, so a field that fails to
    // stick in some form control (e.g. an enum value with no matching
    // <option>) can't silently swap in a stale/default value the way it
    // could when the old flow filled the form and then re-read it.
    run: (payload, hooks) => {
      applyPayload(payload);
      startBacktest(payload, hooks);
    },
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

  // Starts a job from an explicit payload (rather than always re-reading
  // the DOM via buildPayload()) so callers like backtester-ai.js can drive
  // a run straight from a resolved chat config -- the values that were
  // actually agreed on in the conversation -- instead of depending on
  // applyPayload() having round-tripped every field into the form first.
  // /backtest/start on chart_service.py already defaults any field this
  // payload omits (see ORB_DEFAULT_PARAMS there), so a partial payload is
  // fine as long as start/end are present.
  //
  // `hooks` (all optional) lets a caller other than the run button surface
  // progress/completion in its own UI: onStatusChange(text), onProgress({
  // current, total, day }), onDone(job), onError(message). The normal
  // form-driven run path below always passes no hooks, so it behaves
  // exactly as before.
  function startBacktest(payload, hooks) {
    if (running) return;
    if (placeholderNotSet()) {
      const msg = "Set window.CHART_SERVICE_URL in config.js to your ngrok URL first.";
      els.runStatus.textContent = msg;
      if (hooks && hooks.onError) hooks.onError(msg);
      return;
    }
    if (!payload || !payload.start || !payload.end) {
      const msg = "Pick a start and end date.";
      els.runStatus.textContent = msg;
      if (hooks && hooks.onError) hooks.onError(msg);
      return;
    }

    startRunningUi();
    els.results.innerHTML = "";
    if (hooks && hooks.onStatusChange) hooks.onStatusChange("Starting backtest…");

    fetch(`${API()}/backtest/start`, {
      method: "POST",
      headers: FETCH_HEADERS,
      body: JSON.stringify(payload),
    })
      .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || "HTTP " + r.status); return j; }))
      .then((j) => { saveActiveJob(j.job_id); pollJob(j.job_id, hooks); })
      .catch((err) => {
        finishRun();
        els.runStatus.textContent = "Couldn't start backtest: " + err.message;
        if (hooks && hooks.onError) hooks.onError(err.message);
      });
  }

  els.runBtn.addEventListener("click", () => startBacktest(buildPayload()));

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

  function pollJob(jobId, hooks) {
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
            renderResults(job.stats, job.trades || [], /*partial=*/ job.status === "running", { jobId });
          }

          if (job.status === "running") {
            if (job.total) {
              const pct = Math.round((job.current / job.total) * 100);
              els.progressFill.style.width = pct + "%";
              els.progressLabel.textContent = `Day ${job.current}/${job.total}${job.day ? " — " + job.day : ""}`;
              if (hooks && hooks.onProgress) hooks.onProgress({ current: job.current, total: job.total, day: job.day });
            }
            pollTimer = setTimeout(tick, 1200);
            return;
          }
          if (job.status === "error") {
            finishRun();
            els.runStatus.textContent = "Backtest failed: " + job.error;
            if (hooks && hooks.onError) hooks.onError(job.error);
            return;
          }
          if (job.status === "cancelled") {
            els.progressLabel.textContent = "Cancelled.";
            els.runStatus.textContent = `Cancelled — showing results through day ${job.current}/${job.total || "?"}.`;
            renderResults(job.stats, job.trades || [], false, { jobId });
            finishRun();
            if (hooks && hooks.onDone) hooks.onDone(job);
            return;
          }
          // done
          els.progressFill.style.width = "100%";
          els.progressLabel.textContent = "Done.";
          renderResults(job.stats, job.trades || [], false, { jobId });
          loadHistory();
          finishRun();
          if (hooks && hooks.onDone) hooks.onDone(job);
        })
        .catch((err) => {
          finishRun();
          els.runStatus.textContent = "Lost connection while polling: " + err.message;
          if (hooks && hooks.onError) hooks.onError(err.message);
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

  // Last rendered run's trades + a filename-safe label, so the export
  // buttons can serialize exactly what's on screen without re-fetching --
  // this is a snapshot of a finished/partial run, separate from the
  // history entries loaded via /backtest/history.
  let lastTrades = [];
  let lastLabel = "backtest";
  let lastJobId = null;

  function renderResults(stats, trades, partial, opts) {
    opts = opts || {};
    if (!stats || !stats.num_trades) {
      if (partial) return; // still running, just hasn't produced a trade yet -- don't flash an empty-state
      els.results.innerHTML = `<div class="empty-state">No trades matched this config over that date range — try loosening the filters or widening the dates.</div>`;
      return;
    }

    lastTrades = trades || [];
    lastLabel = opts.label || (els.label && els.label.value.trim()) || "backtest";
    lastJobId = opts.jobId || null;

    const partialBanner = partial
      ? `<div class="empty-state small" style="margin-bottom:14px;">Backtest still running — showing results through the last completed day. This updates as more days finish.</div>`
      : opts.historicalNote
        ? `<div class="empty-state small" style="margin-bottom:14px;">${escapeHtml(opts.historicalNote)}</div>`
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
        <div class="stat" title="Estimated round-trip commissions (IBKR tiered-style), already netted out of Net P&amp;L above">
          <div class="label-row"><span class="label">Est. Commissions</span></div>
          <div class="value down">-$${Number(stats.total_commissions_dollars || 0).toFixed(2)}</div>
        </div>
      </div>

      <div class="panel-box" style="margin-bottom:18px;">
        <div class="panel-box-head"><span class="title">Equity Curve</span></div>
        <div id="bt-equity-chart" style="height:240px;"></div>
      </div>

      <div class="panel-box">
        <div class="panel-box-head">
          <span class="title">Trades (${trades.length})</span>
          <div style="display:flex; gap:14px;">
            <button class="link" id="bt-send-journal" type="button" title="Send this run's trades through your n8n trade-journal workflow (chart + vision-LLM verdict + Sheets logging), same as real fills">Send to Journal</button>
            <button class="link" id="bt-export-csv" type="button">Export CSV</button>
            <button class="link" id="bt-export-json" type="button">Export JSON</button>
          </div>
        </div>
        <div style="overflow-x:auto;">
          <table class="data-table">
            <thead><tr>
              <th>Date</th><th>Symbol</th><th>Gap %</th><th>Entry</th><th>Entry $</th>
              <th>Exit</th><th>Exit $</th><th>Reason</th><th>Shares</th><th>Comm. $</th><th>P&amp;L $</th><th>R</th>
            </tr></thead>
            <tbody>${trades.map(tradeRow).join("")}</tbody>
          </table>
        </div>
        <div id="bt-journal-status" style="padding:10px 14px; font-size:12.5px; color:var(--text-faint);"></div>
      </div>
    `;

    renderEquityCurve(stats.equity_curve || []);

    const csvBtn = document.getElementById("bt-export-csv");
    const jsonBtn = document.getElementById("bt-export-json");
    const journalBtn = document.getElementById("bt-send-journal");
    if (csvBtn) csvBtn.addEventListener("click", () => exportTrades("csv"));
    if (jsonBtn) jsonBtn.addEventListener("click", () => exportTrades("json"));
    if (journalBtn) journalBtn.addEventListener("click", () => sendToJournal(journalBtn));
  }

  // Filename-safe stamp + slug shared by both export formats, e.g.
  // "orb-breakout_2026-08-25_1412.csv".
  function exportFileBase() {
    const slug = lastLabel.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "backtest";
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
    return `${slug}_${stamp}`;
  }

  function downloadBlob(content, mime, filename) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const TRADE_COLUMNS = [
    "date", "symbol", "gap_pct", "entry_time", "entry_price",
    "exit_time", "exit_price", "exit_reason", "shares",
    "pnl_dollars_gross", "commission_entry", "commission_exit", "commission_total",
    "pnl_dollars", "r_multiple", "win",
  ];

  function csvEscape(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function tradesToCsv(trades) {
    const header = TRADE_COLUMNS.join(",");
    const rows = trades.map((t) => TRADE_COLUMNS.map((c) => csvEscape(t[c])).join(","));
    return [header, ...rows].join("\r\n");
  }

  // Exports the actual trades from this run (same array driving the table
  // above) as a real downloadable file -- distinct from the saved-run
  // cards in the History panel, which only store aggregate stats + the
  // params used, not the per-trade rows.
  function exportTrades(format) {
    if (!lastTrades.length) return;
    const base = exportFileBase();
    if (format === "csv") {
      downloadBlob(tradesToCsv(lastTrades), "text/csv;charset=utf-8;", `${base}.csv`);
    } else {
      downloadBlob(JSON.stringify(lastTrades, null, 2), "application/json;charset=utf-8;", `${base}.json`);
    }
  }

  // Sends this run's trades through the n8n trade-journal workflow (the
  // same chart-generation -> vision-LLM verdict pipeline real IBKR fills
  // go through) so each backtest trade gets its own analysis -- but
  // scoped entirely to THIS run's own saved report, never written into
  // data/trades.json, the shared Google Sheet, or the main dashboard's
  // stats. n8n should NOT write these into the main trade log at all;
  // instead it POSTs its per-trade output back to `callback_url` below
  // (chart_service.py's POST /backtest/history/<job_id>/enrich), which
  // merges verdict/chart-image/lesson fields onto the matching trade
  // inside this run's own backtest_reports/<job_id>.json. Reopening this
  // run later (View Report) picks up whatever's been merged in, so each
  // backtest ends up with its own self-contained mini report instead of
  // polluting real trading stats.
  //
  // Request body: { run: { label, source: "backtest", job_id,
  // callback_url, started, ended }, trades: [ {date, symbol, entry_time,
  // entry_price, exit_time, exit_price, exit_reason, shares, pnl_dollars,
  // pnl_dollars_gross, commission_total, r_multiple, win}, ... ] }.
  // Expects back { imported: <n> } (or any 2xx) on success -- the actual
  // enrichment arrives asynchronously via the callback, not in this
  // response, since the chart+LLM pass per trade can take a while.
  let journalSendInFlight = false;
  function sendToJournal(btn) {
    if (journalSendInFlight || !lastTrades.length) return;
    const url = window.N8N_BACKTEST_IMPORT_URL || "";
    const statusEl = document.getElementById("bt-journal-status");
    if (!url || url.includes("YOUR-")) {
      if (statusEl) statusEl.textContent = "Set window.N8N_BACKTEST_IMPORT_URL in config.js to your n8n webhook first.";
      return;
    }
    if (!lastJobId) {
      if (statusEl) statusEl.textContent = "This run isn't saved yet (no job id) — wait for it to finish, or reopen it from Past Runs, then try again.";
      return;
    }
    journalSendInFlight = true;
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Sending…";
    if (statusEl) statusEl.textContent = `Sending ${lastTrades.length} trade${lastTrades.length === 1 ? "" : "s"} through the journal workflow — this calls out to n8n, so it can take a while for a full run…`;

    const payload = {
      run: {
        label: lastLabel,
        source: "backtest",
        job_id: lastJobId,
        // Where n8n should POST its per-trade output back to -- keeps
        // this entirely out of the shared Sheet/dashboard. See the
        // function comment above for the full loop.
        callback_url: `${API()}/backtest/history/${lastJobId}/enrich`,
        started: lastTrades[0] ? lastTrades[0].date : null,
        ended: lastTrades[lastTrades.length - 1] ? lastTrades[lastTrades.length - 1].date : null,
      },
      trades: lastTrades.map((t) => ({
        date: t.date,
        symbol: t.symbol,
        entry_time: t.entry_time,
        entry_price: t.entry_price,
        exit_time: t.exit_time,
        exit_price: t.exit_price,
        exit_reason: t.exit_reason,
        shares: t.shares,
        pnl_dollars: t.pnl_dollars,
        pnl_dollars_gross: t.pnl_dollars_gross,
        commission_total: t.commission_total,
        r_multiple: t.r_multiple,
        win: t.win,
      })),
    };

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json().catch(() => ({})); })
      .then((data) => {
        const n = (data && data.imported) || lastTrades.length;
        if (statusEl) statusEl.textContent = `Sent ${n} trade${n === 1 ? "" : "s"} to the journal workflow. Check your dashboard/Sheet once n8n finishes processing.`;
      })
      .catch((err) => {
        if (statusEl) statusEl.textContent = `Couldn't send to journal (${err.message}). If N8N_BACKTEST_IMPORT_URL in config.js still says YOUR-N8N-SUBDOMAIN or the webhook node doesn't exist yet, that's why.`;
      })
      .finally(() => {
        journalSendInFlight = false;
        btn.disabled = false;
        btn.textContent = originalLabel;
      });
  }

  function tradeRow(t) {
    const pillClass = t.win ? "win" : "loss";
    const verdictPill = t.verdict
      ? ` <span class="pill" title="${escapeHtml(String(t.verdict).slice(0, 300))}">AI</span>`
      : "";
    const chartLink = t.chart_image
      ? ` <a href="${escapeHtml(t.chart_image)}" target="_blank" rel="noopener" title="Open this trade's chart from the journal workflow" style="text-decoration:none;">📈</a>`
      : "";
    return `<tr>
      <td>${escapeHtml(t.date)}</td>
      <td>${escapeHtml(t.symbol)}${verdictPill}${chartLink}</td>
      <td>${Number(t.gap_pct).toFixed(1)}%</td>
      <td>${escapeHtml(t.entry_time)}</td>
      <td>$${Number(t.entry_price).toFixed(2)}</td>
      <td>${escapeHtml(t.exit_time)}</td>
      <td>$${Number(t.exit_price).toFixed(2)}</td>
      <td>${escapeHtml(t.exit_reason)}</td>
      <td>${t.shares}</td>
      <td>${t.commission_total ? "$" + Number(t.commission_total).toFixed(2) : "—"}</td>
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
            if (e.target.closest(".run-card-delete") || e.target.closest(".run-card-view")) return;
            applyPayload(entry.params);
          });
          const delBtn = card.querySelector(".run-card-delete");
          if (delBtn) {
            delBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              deleteHistoryEntry(entry.id);
            });
          }
          const viewBtn = card.querySelector(".run-card-view");
          if (viewBtn) {
            viewBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              viewHistoryReport(entry);
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
          <div style="display:flex; align-items:center; gap:10px;">
            <button class="link run-card-view" type="button" title="Open the full saved report for this run">View Report</button>
            <button class="run-card-delete" title="Delete this run" aria-label="Delete this run">&times;</button>
          </div>
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

  // Pulls up the full saved report (every trade, full stats + equity
  // curve) for a past run at any time -- not just the summary stats shown
  // on its card, and not dependent on the in-memory job still existing
  // (that's lost on a server restart; the report file on disk isn't). See
  // GET /backtest/history/<job_id>/report on chart_service.py.
  function viewHistoryReport(entry) {
    els.results.innerHTML = `<div class="empty-state small">Loading saved report…</div>`;
    els.results.scrollIntoView({ behavior: "smooth", block: "start" });
    fetch(`${API()}/backtest/history/${entry.id}/report`, { headers: FETCH_HEADERS })
      .then((r) => {
        if (r.status === 404) throw new Error("No saved report for this run (it may predate this feature) — re-run it to generate one.");
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((report) => {
        const when = report.created_at ? new Date(report.created_at).toLocaleString() : "";
        renderResults(report.stats, report.trades, false, {
          label: report.label || entry.label,
          jobId: entry.id,
          historicalNote: `Viewing saved report${when ? " from " + when : ""} — not a live run. Hit "Run Backtest" to re-run with these settings.`,
        });
      })
      .catch((err) => {
        els.results.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
      });
  }

  function deleteHistoryEntry(id) {
    fetch(`${API()}/backtest/history/${id}`, { method: "DELETE", headers: FETCH_HEADERS })
      .then(() => loadHistory())
      .catch((err) => { els.runStatus.textContent = "Couldn't delete run: " + err.message; });
  }

  loadHistory();
})();
