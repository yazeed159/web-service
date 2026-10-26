// node --test tests/chat-links.test.js
// formatReply() in js/backtester-ai.js turns the AI's reply into HTML. The reply is untrusted, so a
// markdown link must only become an <a> for http(s) URLs -- never javascript:, data:, etc.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const escSrc = read("js/utils.js");
const escStart = escSrc.indexOf("window.escapeHtml = function escapeHtml");
const escBlock = escSrc.slice(escStart, escSrc.indexOf("};", escStart) + 2);
const aiSrc = read("js/backtester-ai.js");
const fnStart = aiSrc.indexOf("function formatReply(text) {");
const fnBlock = aiSrc.slice(fnStart, aiSrc.indexOf("\n  }\n", fnStart) + 4);
const window = {};
new Function("window", escBlock + "\nwindow.escapeHtml = window.escapeHtml;")(window);
const formatReply = new Function("escapeHtml", fnBlock + "\nreturn formatReply;")(window.escapeHtml);

test("an https link becomes a safe anchor", () => {
  const out = formatReply("see [docs](https://example.com/a?b=1&c=2)");
  assert.match(out, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs<\/a>/);
});

test("http links are allowed too", () => {
  assert.match(formatReply("[x](http://example.com)"), /<a href="http:\/\/example\.com"/);
});

test("javascript:, data: and vbscript: links never become anchors", () => {
  for (const url of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,hi", "vbscript:msgbox(1)", "//evil.example"]) {
    const out = formatReply("[click me](" + url + ")");
    assert.ok(!/<a\b/i.test(out), "should not create an anchor for " + url + " but got: " + out);
  }
});

test("HTML in the reply is still escaped", () => {
  const out = formatReply('<img src=x onerror=alert(1)> and [a](https://x.y/"onmouseover="alert(1))');
  assert.ok(!/<img/i.test(out));
  assert.ok(!/"onmouseover=/.test(out.replace(/&quot;/g, "")) || out.includes("&quot;onmouseover"), out);
  assert.ok(!/ onmouseover=/.test(out), out);
});

test("bold still works", () => {
  assert.match(formatReply("a **b** c"), /<strong>b<\/strong>/);
});
