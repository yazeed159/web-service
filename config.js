// Site-wide settings.
// Change your n8n import-form link ONCE here — every page picks it up automatically.
window.N8N_IMPORT_URL = "https://yazeed103.app.n8n.cloud/form/aa6afb02-f2f0-4d5b-b77a-59f9cfecdf6a";
window.N8N_SR_URL = "https://yazeed103.app.n8n.cloud/webhook/support-resistance";
window.N8N_CHAT_URL = "https://yazeed103.app.n8n.cloud/webhook/trade-chat";

// Backtester tab (backtester.html / backtester.js) talks directly to
// chart_service.py's /backtest/* routes -- NOT through n8n, since a
// multi-day scan is started + polled rather than a single request/response.
// Point this at whatever's printed when you run start_chart_service.ps1
// (the ngrok https URL, no trailing slash) -- it changes every time you
// restart ngrok on the free plan, so update this line each session.
window.BACKTESTER_API_URL = "https://YOUR-NGROK-SUBDOMAIN.ngrok-free.app";

document.addEventListener("DOMContentLoaded", function () {
  var link = document.getElementById("import-trades-link");
  if (link && window.N8N_IMPORT_URL) {
    link.href = window.N8N_IMPORT_URL;
  }
});
