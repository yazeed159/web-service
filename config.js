// Site-wide settings.
// Change your n8n import-form link ONCE here — every page picks it up automatically.
window.N8N_IMPORT_URL = "https://yazeed103.app.n8n.cloud/form/aa6afb02-f2f0-4d5b-b77a-59f9cfecdf6a";
window.N8N_SR_URL = "https://yazeed103.app.n8n.cloud/webhook/support-resistance";

document.addEventListener("DOMContentLoaded", function () {
  var link = document.getElementById("import-trades-link");
  if (link && window.N8N_IMPORT_URL) {
    link.href = window.N8N_IMPORT_URL;
  }
});
