// scripts/css-audit.mjs -- READ-ONLY report of CSS rules whose class/id names never appear in any page or script.
//   npm run audit:css            -> summary per stylesheet
//   npm run audit:css -- --list  -> also prints every unused rule (selector + bytes)
// It never edits a file. A class counts as "used" if its name appears anywhere in public/**/*.html or *.js (outside
// vendor/), or if some JS string ends in a prefix like "badge-" / "tone_" that the class starts with (names built at
// runtime). Selectors with no class/id (tags, :root, @keyframes, etc.) are always kept.
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const LIST = process.argv.includes("--list");

async function* walk(d) {
  for (const e of await fs.readdir(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "vendor") yield* walk(p); } else yield p;
  }
}

let corpus = "";
const files = [];
for await (const f of walk(ROOT)) { if (/\.(html|js)$/.test(f)) corpus += (await fs.readFile(f, "utf8")) + "\n"; if (f.endsWith(".css")) files.push(f); }

// Every identifier-like token in the corpus, plus the dynamic prefixes ("foo-" immediately followed by a quote/backtick/+/${).
const tokens = new Set(corpus.match(/[A-Za-z_][\w-]*/g));
const prefixes = new Set();
for (const m of corpus.matchAll(/[A-Za-z_][\w]*[-_](?=["'`+]|\$\{)/g)) prefixes.add(m[0]);
const used = (name) => tokens.has(name) || [...prefixes].some((p) => name.startsWith(p));

function ruleIsUnused(selectorList) {
  let anyKept = false;
  selectorParser((sels) => {
    sels.each((sel) => {
      let names = [];
      sel.walk((n) => { if (n.type === "class" || n.type === "id") names.push(n.value); });
      if (names.length === 0 || names.every(used)) anyKept = true;
    });
  }).processSync(selectorList);
  return !anyKept;
}

const gz = (s) => zlib.gzipSync(s, { level: 9 }).length;
let totRaw = 0, totDead = 0;
for (const f of files.sort()) {
  const src = await fs.readFile(f, "utf8");
  const root = postcss.parse(src);
  let dead = 0; const rows = [];
  root.walkRules((r) => {
    if (r.parent?.type === "atrule" && /keyframes/i.test(r.parent.name)) return;
    let sel; try { sel = r.selector; if (ruleIsUnused(sel)) { const b = Buffer.byteLength(r.toString()); dead += b; rows.push([b, sel.replace(/\s+/g, " ").slice(0, 90)]); } } catch { /* unparseable selector: keep */ }
  });
  totRaw += src.length; totDead += dead;
  console.log(`${path.relative(ROOT, f).padEnd(24)} ${(src.length / 1024).toFixed(0).padStart(5)} KB   unused rules ~${(dead / 1024).toFixed(0).padStart(4)} KB (${(100 * dead / src.length).toFixed(0)}%)`);
  if (LIST) rows.sort((a, b) => b[0] - a[0]).forEach(([b, s]) => console.log(`    ${String(b).padStart(6)}  ${s}`));
}
console.log(`\nTOTAL ${(totRaw / 1024).toFixed(0)} KB, ~${(totDead / 1024).toFixed(0)} KB (${(100 * totDead / totRaw).toFixed(0)}%) look unused. Review before deleting: this is a name search, not a browser test.`);
