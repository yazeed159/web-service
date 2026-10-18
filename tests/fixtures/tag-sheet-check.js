// Child process for tests/tag-catalog-sheet.test.js. Opens the tag sheet repeatedly with a chart service
// that answers successfully. Before the fix, the second click re-opened the sheet forever and locked the
// tab, so the parent runs this with a timeout and treats a hang as a failure.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const file = path.join(__dirname, "../../js/tag-catalog.js");
const src = fs.readFileSync(file, "utf8");
const catalog = JSON.parse(src.match(/var SNAPSHOT = (\{.*\});\n/)[1]);
const dom = new JSDOM('<body><button id="old" data-tag-info="breakout">a</button><button id="ai" data-tag-info="some_ai_lesson">b</button><button id="cur" data-tag-info="revenge_trade">c</button></body>',
  { runScripts: "outside-only", pretendToBeVisual: true, url: "https://x.test/" });
const w = dom.window;
w.CHART_SERVICE_URL = "https://svc.test";
w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(catalog) });
w.eval(src);
const click = (id) => w.document.getElementById(id).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const seen = [];
  for (const id of ["old", "ai", "cur", "old", "ai", "cur"]) {
    click(id); await wait(60);
    const open = w.document.querySelectorAll(".tc-overlay");
    if (open.length !== 1) throw new Error("expected exactly one open sheet, got " + open.length);
    seen.push(w.document.querySelector(".tc-sheet h3").textContent);
  }
  if (seen[0] !== "Breakout (old)") throw new Error("old tag sheet wrong: " + seen[0]);
  if (!/Some ai lesson/.test(seen[1])) throw new Error("AI tag sheet wrong: " + seen[1]);
  if (w.document.activeElement.getAttribute("data-tc-close") === null) throw new Error("close button should take focus");
  w.document.querySelector("[data-tc-close]").click(); await wait(300);
  if (w.document.querySelectorAll(".tc-overlay").length !== 0) throw new Error("sheet did not close");
  console.log("ok");
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
