// node --test tests/error-ship.test.js
// js/app-boot.js sends uncaught errors to POST {CHART_SERVICE_URL}/client-errors (see client_errors.py).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const src = fs.readFileSync(path.join(__dirname, "../js/app-boot.js"), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 15));

function boot({ session = { access_token: "tok-123" }, fetchImpl } = {}) {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", url: "https://app.example/journal.html", virtualConsole: new VirtualConsole() });
  const w = dom.window;
  const calls = [];
  w.CHART_SERVICE_URL = "https://svc.example/";
  w.sb = { auth: { getSession: () => Promise.resolve({ data: { session } }) } };
  w.fetch = fetchImpl ? (u, o) => { calls.push({ url: u, opts: o }); return fetchImpl(u, o); }
                      : (u, o) => { calls.push({ url: u, opts: o }); return Promise.resolve({ ok: true }); };
  w.eval(src);
  // app-boot pings /health on load; only look at error reports.
  const reports = () => calls.filter((c) => c.url.endsWith("/client-errors"));
  const fire = (msg) => w.dispatchEvent(new w.ErrorEvent("error", { message: msg, error: new w.Error(msg), filename: "x.js", lineno: 3 }));
  return { w, calls, reports, fire };
}

test("an uncaught error is POSTed once with the user's token", async () => {
  const { reports, fire } = boot();
  fire("boom one");
  await tick();
  assert.equal(reports().length, 1);
  const c = reports()[0];
  assert.equal(c.url, "https://svc.example/client-errors");
  assert.equal(c.opts.method, "POST");
  assert.equal(c.opts.headers.Authorization, "Bearer tok-123");
  const body = JSON.parse(c.opts.body);
  assert.equal(body.msg, "boom one");
  assert.equal(body.page, "/journal.html");
});

test("the same error is sent only once", async () => {
  const { reports, fire } = boot();
  fire("repeat"); fire("repeat"); fire("repeat");
  await tick();
  assert.equal(reports().length, 1);
});

test("network failures are not reported (the server can't be reached anyway)", async () => {
  const { reports, fire } = boot();
  fire("Failed to fetch");
  await tick();
  assert.equal(reports().length, 0);
});

test("a signed-out visitor sends nothing", async () => {
  const { reports, fire } = boot({ session: null });
  fire("boom signed out");
  await tick();
  assert.equal(reports().length, 0);
});

test("at most 8 distinct errors are sent per page load", async () => {
  const { reports, fire } = boot();
  for (let i = 0; i < 12; i++) fire("distinct " + i);
  await tick();
  assert.equal(reports().length, 8);
});

test("a failing report does not trigger more reports", async () => {
  const { reports, fire } = boot({ fetchImpl: () => Promise.reject(new Error("server down")) });
  fire("first");
  await tick(); await tick();
  assert.equal(reports().length, 1);
});
