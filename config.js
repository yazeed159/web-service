// Site-wide settings.
// Change your import-trades page link ONCE here — every page picks it up automatically.
window.N8N_IMPORT_URL = "import-trades.html";

// SR / Chat / Backtest AI now go straight to chart_service.py on Render
// (ai_routes.py's blueprint) instead of n8n webhooks -- same request/
// response contracts, just served from the same host as CHART_SERVICE_URL
// below. Kept as separate window.* names (not derived from
// CHART_SERVICE_URL) in case you ever want to point them at a different
// host again.
window.N8N_SR_URL = "https://chart-service-wroj.onrender.com/support-resistance";
window.N8N_CHAT_URL = "https://chart-service-wroj.onrender.com/trade-chat";

// "Configure with AI" panel on the Backtester tab (backtester.html /
// backtester-ai.js). Same request/response pattern as N8N_CHAT_URL:
// each turn POSTs { message, history, draft, schema } and expects back
// { reply, config?, status } where status is "asking" while it's still
// gathering info and "ready" once it has enough to show the person a
// final summary to confirm. See the header comment in backtester-ai.js
// for the exact contract -- wire this to a new webhook node in n8n
// (same "Build Prompt -> LLM -> Parse Reply -> Respond" shape as the
// existing "Chat Webhook Trigger" branch).
window.N8N_BACKTEST_AI_URL = "https://chart-service-wroj.onrender.com/backtest-ai";

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
window.N8N_BACKTEST_IMPORT_URL = "https://chart-service-wroj.onrender.com/backtest-import";

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
window.CHART_SERVICE_URL = "https://chart-service-wroj.onrender.com";

// Supabase project -- used by auth.js for login/signup and to read/write
// this user's own trades (Row Level Security scopes every query to
// auth.uid() automatically, so no user_id filtering is needed client-side).
// The anon key is safe to expose in the browser; it can only do what RLS
// allows. NEVER put the service_role key here -- that one only belongs in
// n8n's credentials store.
window.SUPABASE_URL = "https://vxddylzwyyhkvptztkpr.supabase.co";
window.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ4ZGR5bHp3eXloa3ZwdHp0a3ByIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyOTI5MTgsImV4cCI6MjEwMzg2ODkxOH0.c8CsoRwoSSTboXhi8asY3FgFXPCFaCxEOftnACGedrI";

document.addEventListener("DOMContentLoaded", function () {
  var link = document.getElementById("import-trades-link");
  if (link && window.N8N_IMPORT_URL) {
    link.href = window.N8N_IMPORT_URL;
  }
});
