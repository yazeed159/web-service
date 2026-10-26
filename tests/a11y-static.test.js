// node --test tests/a11y-static.test.js
// Runs axe-core over the HTML of every page as shipped (jsdom), so an unlabelled control, a bad ARIA
// role, a duplicate id or a heading/landmark slip fails CI. It does NOT see markup that scripts add
// later, and jsdom has no layout, so colour contrast and "region" are switched off -- those still
// need a real browser (Lighthouse / the axe browser extension).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const root = path.join(__dirname, "..");
const axeSrc = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const pages = fs.readdirSync(root).filter((f) => f.endsWith(".html")).sort();

for (const file of pages) {
  test("axe: " + file, async () => {
    const html = fs.readFileSync(path.join(root, file), "utf8");
    // runScripts is "outside-only": the page's own scripts never run, only axe does.
    const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/" + file, virtualConsole: new VirtualConsole() });
    try {
      dom.window.eval(axeSrc);
      const res = await dom.window.axe.run(dom.window.document, {
        rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
        resultTypes: ["violations"],
      });
      const msg = res.violations.map((v) => v.id + " (" + v.impact + "): " + v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(", ")).join("\n");
      assert.equal(res.violations.length, 0, file + " has accessibility violations:\n" + msg);
    } finally { dom.window.close(); }
  });
}
