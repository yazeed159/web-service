// Site-wide settings.
// Change your n8n import-form link ONCE here — every page picks it up automatically.
window.N8N_IMPORT_URL = "https://yazeed105.app.n8n.cloud/form/aa6afb02-f2f0-4d5b-b77a-59f9cfecdf6a";
window.N8N_SR_URL = "https://yazeed105.app.n8n.cloud/webhook/support-resistance";
window.N8N_CHAT_URL = "https://yazeed105.app.n8n.cloud/webhook/trade-chat";

// "Configure with AI" panel on the Backtester tab (backtester.html /
// backtester-ai.js). Same request/response pattern as N8N_CHAT_URL:
// each turn POSTs { message, history, draft, schema } and expects back
// { reply, config?, status } where status is "asking" while it's still
// gathering info and "ready" once it has enough to show the person a
// final summary to confirm. See the header comment in backtester-ai.js
// for the exact contract -- wire this to a new webhook node in n8n
// (same "Build Prompt -> LLM -> Parse Reply -> Respond" shape as the
// existing "Chat Webhook Trigger" branch).
window.N8N_BACKTEST_AI_URL = "https://yazeed105.app.n8n.cloud/webhook/backtest-ai";

// Backtester tab's "Send to Journal" button (backtester.js). POSTs the
// current run's trades to an n8n webhook so each trade can get the SAME
// chart-generation + vision-LLM verdict treatment a real fill gets.
// IMPORTANT -- this must stay isolated from your real trading journal:
// the webhook node should NOT write these into data/trades.json or the
// shared Google Sheet. Instead have it POST its per-trade output (chart
// image, verdict, lessons, better-entry/exit) back to the `callback_url`
// included in the request body -- chart_service.py's POST
// /backtest/history/<job_id>/enrich -- which merges that onto the
// matching trade inside THIS run's own saved report
// (backtest_reports/<job_id>.json) only. Reopening the run later (View
// Report) then shows it as that run's own self-contained mini report,
// with zero effect on real trading stats/dashboards.
window.N8N_BACKTEST_IMPORT_URL = "https://yazeed105.app.n8n.cloud/webhook/backtest-import";

// Base URL for chart_service.py -- used directly (no n8n) by both:
//  - Backtester tab (backtester.html / backtester.js), for /backtest/* routes
//    (a multi-day scan is started + polled rather than a single request/response)
//  - AI Chat tab (chat.html / chat.js), for a lightweight /generate-chart call
//    when a message clearly refers to a specific logged trade -- gives the
//    model real indicator data (VWAP/EMA/MACD at entry, S/R levels, etc.)
//    instead of just the trade's raw P&L row. Fails silently if unset or
//    unreachable; chat still works off the trade-journal text alone either way.
// Point this at whatever's printed when you run start_chart_service.ps1
// (the ngrok https URL, no trailing slash) -- it changes every time you
// restart ngrok on the free plan, so update this line each session.
window.CHART_SERVICE_URL = "https://sensitize-resurface-semisweet.ngrok-free.dev";

document.addEventListener("DOMContentLoaded", function () {
  var link = document.getElementById("import-trades-link");
  if (link && window.N8N_IMPORT_URL) {
    link.href = window.N8N_IMPORT_URL;
  }
});
