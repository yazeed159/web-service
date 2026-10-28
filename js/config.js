// Site-wide settings.

// Where the Import Trades sidebar link points (js/nav-render.js reads this at render time).
window.IMPORT_URL = "import-trades.html";

// chart_service.py -- the Flask API deployed on Render (see the companion chart-service repo).
// Everything AI/heavy goes through it: support/resistance, chat, backtests, chart generation, CSV import.
// The Render URL is stable. (Free instances sleep when idle, so the first request after a quiet spell can
// take a while; js/utils.js's ServiceWake shows a "waking the server" note while that happens.)
window.CHART_SERVICE_URL = "https://chart-service-wroj.onrender.com";

// Endpoints on that service. Each is derived from CHART_SERVICE_URL so there is one place to change.
window.SR_URL = window.CHART_SERVICE_URL + "/support-resistance";            // trade.html / practice.html S/R
window.CHAT_URL = window.CHART_SERVICE_URL + "/trade-chat";                  // floating chat bubble
window.BACKTEST_AI_URL = window.CHART_SERVICE_URL + "/backtest-ai";          // Backtester "Configure with AI"
// Backtester "Send to Journal": POSTs a run's trades so each gets the same chart + AI verdict treatment as a
// real fill. It is isolated from the real journal -- results are merged back onto that run's own saved report only
// (POST /backtest/history/<job_id>/enrich), never into real trades or dashboards.
window.BACKTEST_IMPORT_URL = window.CHART_SERVICE_URL + "/backtest-import";

// Legacy names from when these were n8n webhooks. Nothing should need them any more, but old code and
// bookmarks of this file may still read them, so they stay as aliases.
window.N8N_IMPORT_URL = window.IMPORT_URL;
window.N8N_SR_URL = window.SR_URL;
window.N8N_CHAT_URL = window.CHAT_URL;
window.N8N_BACKTEST_AI_URL = window.BACKTEST_AI_URL;
window.N8N_BACKTEST_IMPORT_URL = window.BACKTEST_IMPORT_URL;

// live-trading.html / live-trading.js. THIS IS NOT chart_service.py --
// it's live-service, a separate Docker container that runs on YOUR OWN
// machine next to IB Gateway (see the live-trading-stack repo's
// docker-compose.yml), because it needs to hold an open connection to
// Gateway continuously, which Render can't do reliably. Point this at
// whatever tunnel (Cloudflare Tunnel / ngrok) you put in front of its
// port 8800. Leave blank and the Live Trading page will just show an
// error instead of failing silently.
// NOTE: unlike CHART_SERVICE_URL above, this genuinely IS a rotating
// trycloudflare.com quick-tunnel URL -- it changes whenever the tunnel
// restarts (reboot, network drop, etc.), and there's no indicator
// anywhere in the UI when it's gone stale beyond Live Trading showing
// an error. Update this line whenever you restart the tunnel.
window.LIVE_SERVICE_URL = "https://pushing-republican-education-livecam.trycloudflare.com";

// Supabase project -- used by auth.js for login/signup and to read/write
// this user's own trades (Row Level Security scopes every query to
// auth.uid() automatically, so no user_id filtering is needed client-side).
// The anon key is safe to expose in the browser; it can only do what RLS
// allows. NEVER put the service_role key here -- that one belongs only in
// server-side secrets (the Render service / GitHub Actions), never in the browser.
window.SUPABASE_URL = "https://vxddylzwyyhkvptztkpr.supabase.co";
window.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ4ZGR5bHp3eXloa3ZwdHp0a3ByIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyOTI5MTgsImV4cCI6MjEwMzg2ODkxOH0.c8CsoRwoSSTboXhi8asY3FgFXPCFaCxEOftnACGedrI";

// Note: the Import Trades sidebar link no longer needs a patch here --
// js/nav-render.js resolves window.IMPORT_URL itself at render time
// (including on every SPA navigation, not just once on initial load).
