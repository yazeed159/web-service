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

  // chart_service.py's /backtest/* routes now scope every run to whoever
  // started it (see chart_service.py's _require_user / backtest_storage.py)
  // -- backtests used to be shared/anonymous across every account. Every
  // call that starts, polls, lists, loads, or deletes a run needs the
  // logged-in person's Supabase access token attached; /backtest/defaults
  // is the one exception (no user data involved, so it's left plain).
  // window.AUTH_READY (see auth.js) resolves once per page load and is
  // safe to .then() repeatedly -- it doesn't re-fetch the session each time.
  function authedHeaders(extra) {
    return window.AUTH_READY.then((session) => {
      if (!session) throw new Error("Please log in first.");
      return Object.assign({}, FETCH_HEADERS, extra || {}, { "Authorization": "Bearer " + session.access_token });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Auto-fires the same "Send to Journal" call report.js's button does,
  // right when a run finishes here -- so by the time you open the full
  // report, the per-trade charts are already rendering (or done) instead
  // of needing an extra manual click first. chart_only:true tells
  // chart_service.py's /backtest-import + /enrich to draw the candlestick
  // chart with entry/exit price lines only (same Polygon-bar data every
  // chart needs anyway) and SKIP the vision-LLM verdict/grading call --
  // that's the only step of this pipeline that spends AI tokens, and nobody
  // reads it off a backtest run. NOTE: this flag only takes effect once
  // chart_service.py (companion chart-service repo, not part of this
  // frontend) is updated to check for it and branch around its verdict
  // call -- until then it's a no-op there and the full pipeline still runs.
  // Fire-and-forget: runs once per finished job, silently skipped if
  // N8N_BACKTEST_IMPORT_URL isn't configured, no UI blocking either way --
  // charts show up whenever they show up when the report page is opened.
  const autoChartedJobs = new Set();
  function autoGenerateCharts(job) {
    if (!job || !job.job_id || autoChartedJobs.has(job.job_id)) return;
    const trades = job.trades || [];
    if (!trades.length) return;
    const url = window.N8N_BACKTEST_IMPORT_URL || "";
    if (!url || url.includes("YOUR-")) return; // not configured -- stay quiet, same as report.js
    autoChartedJobs.add(job.job_id);
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        run: {
          label: (els.label && els.label.value.trim()) || "backtest", source: "backtest", job_id: job.job_id,
          callback_url: `${API()}/backtest/history/${job.job_id}/enrich`,
          started: trades[0] ? trades[0].date : null, ended: trades[trades.length - 1] ? trades[trades.length - 1].date : null,
          chart_only: true,
        },
        trades: trades.map((t) => ({
          date: t.date, symbol: t.symbol, entry_time: t.entry_time, entry_price: t.entry_price,
          exit_time: t.exit_time, exit_price: t.exit_price, exit_reason: t.exit_reason, shares: t.shares,
          pnl_dollars: t.pnl_dollars, pnl_dollars_gross: t.pnl_dollars_gross, commission_total: t.commission_total,
          r_multiple: t.r_multiple, win: t.win,
        })),
      }),
    })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); })
      .then(() => {
        els.runStatus.textContent = "Done. Trade charts are rendering in the background — open the full report in a bit to see them.";
      })
      .catch(() => {
        // best effort -- don't disrupt the run's own success state over this;
        // the manual "Generate Trade Charts" button on report.html covers a retry.
        autoChartedJobs.delete(job.job_id);
      });
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
    startingCapital: document.getElementById("bt-starting-capital"),
    positionSizingMode: document.getElementById("bt-position-sizing-mode"),
    positionSizePct: document.getElementById("bt-position-size-pct"),
    riskPctOfCapital: document.getElementById("bt-risk-pct-of-capital"),
    includeCommissions: document.getElementById("bt-include-commissions"),
    slippageBps: document.getElementById("bt-slippage-bps"),
    sessionStart: document.getElementById("bt-session-start"),
    flattenTime: document.getElementById("bt-flatten-time"),
    notes: document.getElementById("bt-notes"),
    entryMode: document.getElementById("bt-entry-mode"),
    orbMinutes: document.getElementById("bt-orb-minutes"),
    entryAfterOrb: document.getElementById("bt-entry-after-orb"),
    donchianLookback: document.getElementById("bt-donchian-lookback"),
    emaPeriod: document.getElementById("bt-ema-period"),
    macdFast: document.getElementById("bt-macd-fast"),
    macdSlow: document.getElementById("bt-macd-slow"),
    macdSignal: document.getElementById("bt-macd-signal"),
    rsiPeriod: document.getElementById("bt-rsi-period"),
    rsiOversold: document.getElementById("bt-rsi-oversold"),
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
    allowReentry: document.getElementById("bt-allow-reentry"),
    maxTradesPerDay: document.getElementById("bt-max-trades-per-day"),
    reentryCooldownMinutes: document.getElementById("bt-reentry-cooldown-minutes"),
    scaleInEnabled: document.getElementById("bt-scale-in-enabled"),
    scaleInInitialPct: document.getElementById("bt-scale-in-initial-pct"),
    scaleInAddPct: document.getElementById("bt-scale-in-add-pct"),
    scaleInMaxAdds: document.getElementById("bt-scale-in-max-adds"),
    scaleInHoldBars: document.getElementById("bt-scale-in-hold-bars"),
    scaleInMinGainCents: document.getElementById("bt-scale-in-min-gain-cents"),
    trailProtectEnabled: document.getElementById("bt-trail-protect-enabled"),
    trailProtectLadder: document.getElementById("bt-trail-protect-ladder"),
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

  // Fields tagged data-show-when="<select-id>=<val1>,<val2>,..." in the
  // HTML are only relevant for some entry_mode/stop_mode/position_sizing_mode
  // choices -- e.g. "Donchian lookback" only does anything when Entry style
  // is set to the Donchian breakout, "ATR period/mult" only matter for the
  // ATR stop style, etc. (see orb_strategy.py's dispatch logic: an unused
  // field's value is simply never read). Rather than show every knob all
  // the time -- which makes it look like changing an ATR field while on a
  // fixed-cents stop would do something -- hide whatever the current mode
  // selections don't use. The underlying <input> is still there and still
  // gets sent by buildPayload() (harmless; the backend ignores it), this
  // only affects what's visible.
  function syncConditionalFields() {
    document.querySelectorAll("[data-show-when]").forEach((el) => {
      const [ctrlId, allowedCsv] = el.dataset.showWhen.split("=");
      const ctrl = document.getElementById(ctrlId);
      if (!ctrl) return;
      const allowed = allowedCsv.split(",");
      el.style.display = allowed.includes(ctrl.value) ? "" : "none";
    });
  }
  ["bt-entry-mode", "bt-stop-mode", "bt-position-sizing-mode"].forEach((id) => {
    const ctrl = document.getElementById(id);
    if (ctrl) ctrl.addEventListener("change", syncConditionalFields);
  });
  syncConditionalFields();

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

  // trail_protect_ladder travels over the wire as [[peak_r, protect_frac_0_to_1], ...]
  // (see orb_strategy.py / backtester-ai.js FIELD_SCHEMA), but the form field is a
  // single human-typed "1:50, 2:65, 3:80" text input (R:percent). These two convert
  // between the two shapes so buildPayload()/applyPayload() can round-trip it.
  function parseLadderInput(str) {
    return (str || "")
      .split(",")
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => chunk.split(":").map((n) => parseFloat(n.trim())))
      .filter(([r, pct]) => Number.isFinite(r) && Number.isFinite(pct))
      .map(([r, pct]) => [r, pct > 1 ? pct / 100 : pct]);
  }
  function formatLadderValue(ladder) {
    if (!Array.isArray(ladder) || !ladder.length) return "";
    return ladder
      .map(([r, frac]) => `${r}:${Math.round(frac > 1 ? frac : frac * 100)}`)
      .join(", ");
  }

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
      starting_capital: els.startingCapital ? Number(els.startingCapital.value) || 0 : undefined,
      position_sizing_mode: els.positionSizingMode ? els.positionSizingMode.value : "fixed_dollars",
      position_size_pct: els.positionSizePct ? Number(els.positionSizePct.value) || 0 : undefined,
      risk_pct_of_capital: els.riskPctOfCapital ? Number(els.riskPctOfCapital.value) || 0 : undefined,
      include_commissions: els.includeCommissions ? !!els.includeCommissions.checked : true,
      // 0 is a valid, meaningful value here (slippage off) -- don't let
      // the usual `|| default` pattern stomp it back to the default.
      slippage_bps: els.slippageBps && els.slippageBps.value !== "" ? Number(els.slippageBps.value) : 5,
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
      ema_period: els.emaPeriod ? Number(els.emaPeriod.value) || 9 : 9,
      macd_fast: els.macdFast ? Number(els.macdFast.value) || 12 : 12,
      macd_slow: els.macdSlow ? Number(els.macdSlow.value) || 26 : 26,
      macd_signal: els.macdSignal ? Number(els.macdSignal.value) || 9 : 9,
      rsi_period: els.rsiPeriod ? Number(els.rsiPeriod.value) || 14 : 14,
      rsi_oversold: els.rsiOversold ? Number(els.rsiOversold.value) || 30 : 30,

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
      // Re-entry: checkbox defaults checked in the HTML, so an unset/absent
      // element still resolves true here rather than silently defaulting
      // off, matching this feature's backend default.
      allow_reentry: els.allowReentry ? !!els.allowReentry.checked : true,
      max_trades_per_day: els.maxTradesPerDay ? Number(els.maxTradesPerDay.value) || 3 : 3,
      reentry_cooldown_minutes: els.reentryCooldownMinutes ? Number(els.reentryCooldownMinutes.value) || 0 : 0,

      scale_in_enabled: els.scaleInEnabled ? !!els.scaleInEnabled.checked : false,
      scale_in_initial_size_pct: els.scaleInInitialPct ? Number(els.scaleInInitialPct.value) || 50 : 50,
      scale_in_add_size_pct: els.scaleInAddPct ? Number(els.scaleInAddPct.value) || 25 : 25,
      scale_in_max_adds: els.scaleInMaxAdds ? Number(els.scaleInMaxAdds.value) || 0 : 0,
      scale_in_hold_bars: els.scaleInHoldBars ? Number(els.scaleInHoldBars.value) || 2 : 2,
      scale_in_min_gain_cents: els.scaleInMinGainCents ? Number(els.scaleInMinGainCents.value) || 0 : 0,
      trail_protect_enabled: els.trailProtectEnabled ? !!els.trailProtectEnabled.checked : false,
      trail_protect_ladder: els.trailProtectLadder ? parseLadderInput(els.trailProtectLadder.value) : [],
    };
  }

  // Writes whatever `p` specifies into the form. Fields `p` doesn't
  // mention are left exactly as they already are -- this is the raw
  // "patch" primitive. applyPayload() below (the one everything else
  // calls) always resets to DEFAULT_PAYLOAD first, so a caller only ever
  // sees this partial-patch behavior indirectly, via a full reset+patch.
  function patchPayload(p) {
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
    set(els.startingCapital, p.starting_capital);
    set(els.positionSizingMode, p.position_sizing_mode);
    set(els.positionSizePct, p.position_size_pct);
    set(els.riskPctOfCapital, p.risk_pct_of_capital);
    setChk(els.includeCommissions, p.include_commissions !== false);
    set(els.slippageBps, p.slippage_bps);
    set(els.sessionStart, p.session_start);
    set(els.flattenTime, p.flatten_time);
    set(els.notes, p.notes);
    set(els.entryMode, p.entry_mode);
    set(els.orbMinutes, p.orb_minutes);
    setChk(els.entryAfterOrb, p.entry_after_orb !== false);
    set(els.donchianLookback, p.donchian_lookback);
    set(els.emaPeriod, p.ema_period);
    set(els.macdFast, p.macd_fast);
    set(els.macdSlow, p.macd_slow);
    set(els.macdSignal, p.macd_signal);
    set(els.rsiPeriod, p.rsi_period);
    set(els.rsiOversold, p.rsi_oversold);
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
    setChk(els.allowReentry, p.allow_reentry !== false);
    set(els.maxTradesPerDay, p.max_trades_per_day);
    set(els.reentryCooldownMinutes, p.reentry_cooldown_minutes);
    setChk(els.scaleInEnabled, p.scale_in_enabled);
    set(els.scaleInInitialPct, p.scale_in_initial_size_pct);
    set(els.scaleInAddPct, p.scale_in_add_size_pct);
    set(els.scaleInMaxAdds, p.scale_in_max_adds);
    set(els.scaleInHoldBars, p.scale_in_hold_bars);
    set(els.scaleInMinGainCents, p.scale_in_min_gain_cents);
    setChk(els.trailProtectEnabled, p.trail_protect_enabled);
    if (els.trailProtectLadder && p.trail_protect_ladder !== undefined) {
      els.trailProtectLadder.value = formatLadderValue(p.trail_protect_ladder);
    }
    // Setting .value programmatically (as every line above just did) never
    // fires a "change" event, so the visibility toggling wired up near
    // checkApi() wouldn't otherwise notice entry_mode/stop_mode/
    // position_sizing_mode changed -- re-run it explicitly here.
    syncConditionalFields();
    // Note: no scroll call here on purpose. flashFormSections() (called
    // right after this by backtester-ai.js) does the scrolling -- having
    // both fire in the same tick made the page jump to two different
    // targets and land on whichever won the race, which looked like the
    // just-filled form had vanished.
  }

  // Snapshot of every field's HTML-authored default, taken once at load --
  // before any strategy, preset, or chat draft has touched the form. This
  // is the "nothing" side of "the strat matches the form, nothing more,
  // nothing less": applying a strategy always resets to this baseline
  // first (see applyPayload below), so a toggle a *previous* strategy
  // turned on (scale-in, trail-protect, a time stop...) can never bleed
  // into the next one just because the new strategy's config didn't
  // mention it. Needs `els` populated and seedDates() already run, both
  // of which have happened by this point in the file.
  const DEFAULT_PAYLOAD = buildPayload();

  // The real entry point everything on this page (and backtester-ai.js,
  // via window.BacktesterForm.apply) uses to put a strategy into the
  // form. Always resets to DEFAULT_PAYLOAD first, then patches in `p` --
  // so the visible form is an exact mirror of `p`: fields `p` sets show
  // p's values, and every other field (including ones a *different*
  // previously-loaded strategy left on) lands back at its off/default
  // state instead of lingering. `patchPayload` above is the raw partial
  // write if some future caller genuinely wants that instead.
  function applyPayload(p) {
    patchPayload(DEFAULT_PAYLOAD);
    patchPayload(p);
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

    authedHeaders()
      .then((headers) => fetch(`${API()}/backtest/start`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      }))
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
      authedHeaders()
        .then((headers) => fetch(`${API()}/backtest/cancel/${currentJobId}`, { method: "POST", headers }))
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
      authedHeaders()
        .then((headers) => fetch(`${API()}/backtest/status/${jobId}`, { headers }))
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
            job.job_id = jobId;
            if (hooks && hooks.onDone) hooks.onDone(job);
            return;
          }
          // done
          els.progressFill.style.width = "100%";
          els.progressLabel.textContent = "Done.";
          renderResults(job.stats, job.trades || [], false, { jobId });
          loadHistory();
          finishRun();
          job.job_id = jobId;
          autoGenerateCharts(job);
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
    authedHeaders()
      .then((headers) => fetch(`${API()}/backtest/status/${jobId}`, { headers }))
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

  // Compact "done" card instead of the old full inline dashboard -- the
  // full breakdown (equity curve, trade table, journal, CSV/JSON export,
  // Send to Journal) now lives on its own page (report.html), one per
  // run, so this page stays about configuring + kicking off runs rather
  // than displaying them.
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
      ? `<div class="empty-state small" style="margin-bottom:14px;">Backtest still running — showing a live summary through the last completed day.</div>`
      : opts.historicalNote
        ? `<div class="empty-state small" style="margin-bottom:14px;">${escapeHtml(opts.historicalNote)}</div>`
        : "";

    const reportHref = lastJobId ? `report.html?id=${encodeURIComponent(lastJobId)}` : null;

    els.results.innerHTML = `
      ${partialBanner}
      <div class="panel-box">
        <div class="panel-box-head">
          <span class="title">${partial ? "Running…" : "Done"}</span>
          ${reportHref && !partial ? `<a class="link" href="${reportHref}" target="_blank" rel="noopener">Open full report →</a>` : ""}
        </div>
        ${lastJobId && !partial ? `<div style="margin-bottom:12px;"><button class="link" id="bt-save-strategy-btn" style="background:none;border:none;padding:0;cursor:pointer;">Save as Strategy →</button></div>` : ""}
        <div class="stat-grid">
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
        </div>
        ${reportHref && !partial ? `<div class="bt-run-row" style="margin-top:16px;"><a class="btn-confirm" style="text-decoration:none; display:inline-block;" href="${reportHref}" target="_blank" rel="noopener">View Full Report</a></div>` : ""}
      </div>
    `;

    const saveBtn = document.getElementById("bt-save-strategy-btn");
    if (saveBtn) saveBtn.addEventListener("click", () => saveAsStrategy(lastJobId, lastLabel, saveBtn));
  }

  // --- Strategies section: built-in presets + whatever's actually saved
  // (chart_service.py's /strategies, backed by strategy_store.py -- the
  // same store the Live Trading page's picker reads). Unlike the old
  // "chat chip" presets (which were just prefilled text that still had to
  // round-trip through the AI), clicking a card here loads the strategy
  // straight into the form below via applyPayload() -- no network call,
  // instant, and exact. This is the one list of "strategies you can pick"
  // on the page; saving a run here (saveAsStrategy(), below) adds to it
  // immediately, and the same saved row is what shows up in Live
  // Trading's strategy picker.
  function defaultDateRange(days) {
    const end = new Date();
    end.setDate(end.getDate() - 1);
    const start = new Date(end);
    start.setDate(start.getDate() - days);
    const fmt = (d) => d.toISOString().slice(0, 10);
    return { start: fmt(start), end: fmt(end) };
  }

  function humanizeMode(m) {
    return String(m || "").replace(/_/g, " ");
  }

  // Saved strategy rows (chart_service.py's strategy_store.py) split a
  // strategy into entry_mode + params (the trade rule) + symbol_rule (the
  // scan), with backtest-only settings like starting_capital/date range
  // stripped out (see chart_service.py's _BACKTEST_ONLY_KEYS) since Live
  // Trading has no use for them. Recombine into a flat payload the form
  // understands; whatever's missing (date range, starting capital, ...)
  // just falls back to DEFAULT_PAYLOAD via applyPayload()'s reset.
  function strategyRowToPayload(row) {
    const rule = row.symbol_rule || {};
    const scan = rule.mode === "top_gappers"
      ? {
          top_n: rule.top_n, min_price: rule.min_price, max_price: rule.max_price,
          min_dollar_volume: rule.min_dollar_volume, min_gap_pct: rule.min_gap_pct,
        }
      : {};
    return Object.assign({ label: row.name, entry_mode: row.entry_mode }, scan, row.params || {});
  }

  function loadStrategyIntoForm(row) {
    let payload = row.isPreset
      ? Object.assign({ label: row.name }, row.config)
      : strategyRowToPayload(row);
    if (!payload.start || !payload.end) {
      payload = Object.assign({}, payload, defaultDateRange(60));
    }
    applyPayload(payload);
    const details = document.getElementById("bt-manual-details");
    if (details) {
      details.open = true; // fires "toggle" -> the listener in backtester.html scrolls to it
      details.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    document.querySelectorAll(".bt-section:not(.ai-cfg-panel), .bt-run-row").forEach((el) => {
      el.classList.remove("just-applied");
      void el.offsetWidth; // restart animation
      el.classList.add("just-applied");
    });
  }

  function strategyCard(s) {
    const stats = s.source_summary_stats || {};
    const hasStats = typeof stats.num_trades === "number" && stats.num_trades > 0;
    const pnlClass = (stats.net_pnl_dollars || 0) >= 0 ? "up" : "down";
    return `
      <div class="run-card" id="bt-strat-${escapeHtml(s.id)}" title="Click to load this strategy into the form below">
        <div class="run-card-head">
          <span class="run-card-title">${escapeHtml(s.name)}</span>
          <div style="display:flex; align-items:center; gap:10px;">
            <span class="pill tagpill">${s.isPreset ? "Preset" : "Saved"}</span>
            ${s.isPreset ? "" : `<button class="run-card-delete strat-card-delete" title="Delete this strategy" aria-label="Delete this strategy">&times;</button>`}
          </div>
        </div>
        <div class="run-card-date">${escapeHtml(humanizeMode(s.entry_mode))}</div>
        ${hasStats
          ? `<div class="run-card-stats" style="margin-top:10px;">
              <div><div class="pb-label">Net P&amp;L</div><div class="pb-value" style="color:${pnlClass === "up" ? "var(--green)" : "var(--red)"}">${fmtMoney(stats.net_pnl_dollars)}</div></div>
              <div><div class="pb-label">Win Rate</div><div class="pb-value">${fmtPct(stats.win_rate)}</div></div>
            </div>`
          : `<div class="empty-state small" style="margin-top:8px;">${s.isPreset ? "Starter preset — no backtest attached." : "No backtest stats on record."}</div>`}
      </div>`;
  }

  function wireStrategyCards(list) {
    list.forEach((s) => {
      const card = document.getElementById(`bt-strat-${s.id}`);
      if (!card) return;
      card.addEventListener("click", (e) => {
        if (e.target.closest(".strat-card-delete")) return;
        loadStrategyIntoForm(s);
      });
      const delBtn = card.querySelector(".strat-card-delete");
      if (delBtn) {
        delBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!window.confirm(`Delete "${s.name}"? This can't be undone, and it'll disappear from the Live Trading picker too.`)) return;
          authedHeaders()
            .then((headers) => fetch(`${API()}/strategies/${encodeURIComponent(s.id)}`, { method: "DELETE", headers }))
            .then(() => loadStrategiesSection())
            .catch((err) => alert("Couldn't delete: " + err.message));
        });
      }
    });
  }

  function loadStrategiesSection() {
    const el = document.getElementById("bt-strategies");
    if (!el) return;
    const presets = (window.STRATEGY_PRESETS || []).map((p, i) => ({
      id: "preset-" + i, name: p.name, entry_mode: p.config.entry_mode, config: p.config, isPreset: true,
    }));
    const render = (saved) => {
      const all = presets.concat(saved);
      el.innerHTML = all.length
        ? `<div class="playbook-grid">${all.map(strategyCard).join("")}</div>`
        : `<div class="empty-state small">No strategies yet.</div>`;
      wireStrategyCards(all);
    };
    if (placeholderNotSet()) { render([]); return; }
    authedHeaders()
      .then((headers) => fetch(`${API()}/strategies`, { headers }))
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((rows) => render((rows || []).map((r) => Object.assign({}, r, { isPreset: false }))))
      .catch((err) => {
        // Built-in presets don't need the API -- still show those even if
        // the saved-strategies fetch failed (e.g. not logged in yet).
        render([]);
        el.insertAdjacentHTML("beforeend", `<div class="empty-state small" style="margin-top:10px;">Couldn't load your saved strategies (${escapeHtml(err.message)}).</div>`);
      });
  }

  function loadHistory() {
    if (placeholderNotSet()) {
      els.history.innerHTML = `<div class="empty-state small">Set window.CHART_SERVICE_URL in config.js to see past runs.</div>`;
      return;
    }
    authedHeaders()
      .then((headers) => fetch(`${API()}/backtest/history`, { headers }))
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((entries) => {
        if (!entries.length) {
          els.history.innerHTML = `<div class="empty-state small">No runs yet — describe a strategy in the chat above and it'll show up here once it finishes.</div>`;
          return;
        }
        els.history.innerHTML = `<div class="playbook-grid">${entries.map(historyCard).join("")}</div>`;
        entries.forEach((entry) => {
          const card = document.getElementById(`bt-run-${entry.id}`);
          if (!card) return;
          card.addEventListener("click", (e) => {
            if (e.target.closest(".run-card-delete") || e.target.closest(".run-card-view")) return;
            applyPayload(entry.params);
            const details = document.getElementById("bt-manual-details");
            if (details) { details.open = true; details.scrollIntoView({ behavior: "smooth", block: "start" }); }
          });
          const delBtn = card.querySelector(".run-card-delete");
          if (delBtn) {
            delBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              deleteHistoryEntry(entry.id);
            });
          }
          const saveBtn = card.querySelector(".run-card-save-strategy");
          if (saveBtn) {
            saveBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              saveAsStrategy(entry.id, entry.label, saveBtn);
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
      <div class="run-card" id="bt-run-${entry.id}" title="Click to load these settings back into the manual override form">
        <div class="run-card-head">
          <span class="run-card-title">${escapeHtml(entry.label || "(untitled run)")}</span>
          <div style="display:flex; align-items:center; gap:10px;">
            <button class="link run-card-save-strategy" style="background:none;border:none;padding:0;cursor:pointer;" title="Save this run's rules as a reusable strategy you can pick on the Live Trading page">Save as Strategy</button>
            <a class="link run-card-view" href="report.html?id=${encodeURIComponent(entry.id)}" target="_blank" rel="noopener" title="Open the full saved report for this run">View Report</a>
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

  // Turns a finished run into a reusable strategy (chart_service.py's
  // /backtest/history/<id>/save-strategy) -- the thing that connects this
  // page to the Live Trading picker. Shared by the "Done" results panel
  // (fresh run) and each history card (an older run).
  function saveAsStrategy(jobId, defaultName, btn) {
    const name = window.prompt("Name this strategy (you'll pick it by this name on the Live Trading page):", defaultName || "");
    if (name === null) return; // cancelled
    const trimmed = name.trim();
    if (!trimmed) { alert("Strategy name is required."); return; }
    const originalLabel = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    authedHeaders()
      .then((headers) => fetch(`${API()}/backtest/history/${jobId}/save-strategy`, {
        method: "POST", headers, body: JSON.stringify({ name: trimmed }),
      }))
      .then((r) => r.json().then((body) => {
        if (!r.ok) throw new Error(body.error || ("HTTP " + r.status));
        return body;
      }))
      .then(() => {
        loadStrategiesSection();
        alert(`Saved "${trimmed}" to your Strategies, above -- it'll also show up in the strategy picker on the Live Trading page.`);
      })
      .catch((err) => alert("Couldn't save strategy: " + err.message))
      .finally(() => { if (btn) { btn.disabled = false; btn.textContent = originalLabel; } });
  }

  function deleteHistoryEntry(id) {
    authedHeaders()
      .then((headers) => fetch(`${API()}/backtest/history/${id}`, { method: "DELETE", headers }))
      .then(() => loadHistory())
      .catch((err) => { els.runStatus.textContent = "Couldn't delete run: " + err.message; });
  }

  loadStrategiesSection();
  loadHistory();
})();
