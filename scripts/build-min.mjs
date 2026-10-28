// scripts/build-min.mjs -- OPTIONAL minified build. Your source files are never changed.
//
//   npm run build:min      ->  writes a smaller copy of the site into ./dist
//   npm run deploy:min     ->  builds, then deploys ./dist (uses wrangler.min.jsonc)
//
// What it does
//   * copies every file the site needs into ./dist (same list wrangler uses: see .assetsignore)
//   * minifies the .js and .css files in the COPY (comments and spacing removed, names shortened inside functions)
//   * leaves .html, images, manifest, _headers, sw.js and js/vendor/* exactly as they are
//
// What it does NOT do
//   * it never writes to js/, css/ or any page in the project folder -- only to ./dist
//   * it does not bundle or rename files, so every <script src> / <link href> still points at the same path
//
// Normal deploys (git push -> Cloudflare serving "." as-is, wrangler.jsonc) are untouched by this file.

import { build, transform } from "esbuild";   // eslint-disable-line -- installed as a devDependency
import { promises as fs } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(ROOT, "dist");

// Never copied into dist (mirrors .assetsignore, plus dist itself and this script).
const SKIP_DIRS = new Set(["node_modules", "tests", "test-results", "playwright-report", ".git", ".github", ".wrangler", "dist", "scripts"]);
const SKIP_FILES = new Set(["package.json", "package-lock.json", "bun.lock", "bun.lockb", "playwright.config.js", "push.bat",
  "wrangler.jsonc", "wrangler.min.jsonc", ".assetsignore", ".gitignore", "README.md"]);
// Copied untouched even though they are .js: the service worker (keep it debuggable) and already-minified libraries.
const KEEP_AS_IS = (rel) => rel === "sw.js" || rel.startsWith("js/vendor/");

async function* walk(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name)); }
    else if (!SKIP_FILES.has(e.name)) yield path.join(dir, e.name);
  }
}

const gz = (buf) => zlib.gzipSync(buf, { level: 9 }).length;
const kb = (n) => (n / 1024).toFixed(0) + " KB";

await fs.rm(OUT, { recursive: true, force: true });
let rawTotal = 0, minTotal = 0, gzRaw = 0, gzMin = 0, files = 0, minified = 0;

for await (const abs of walk(ROOT)) {
  const rel = path.relative(ROOT, abs).split(path.sep).join("/");
  const dest = path.join(OUT, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const ext = path.extname(rel);
  files++;
  if ((ext === ".js" || ext === ".css") && !KEEP_AS_IS(rel)) {
    const src = await fs.readFile(abs, "utf8");
    // transform (not bundle): one file in, one file out. Top-level names are left alone in this mode, so scripts that
    // share globals (window.escapeHtml, etc.) keep working; only names inside functions get shortened.
    const out = await transform(src, { loader: ext === ".js" ? "js" : "css", minify: true, legalComments: "none", target: "es2020" });
    await fs.writeFile(dest, out.code);
    rawTotal += Buffer.byteLength(src); minTotal += Buffer.byteLength(out.code);
    gzRaw += gz(src); gzMin += gz(out.code); minified++;
  } else {
    await fs.copyFile(abs, dest);
  }
}

console.log(`dist/ ready: ${files} files (${minified} JS/CSS minified)`);
console.log(`  JS+CSS size : ${kb(rawTotal)} -> ${kb(minTotal)}`);
console.log(`  gzip (what visitors download): ${kb(gzRaw)} -> ${kb(gzMin)}`);
console.log("Source files were not modified.");
