# E2E smoke tests

Regression coverage for `js/page-transition.js`'s SPA router — specifically
the "stale sidebar" class of bug (nav highlight or status label left over
from the page you navigated *from*). See the "Known page-specific regions
of the persistent shell" comment at the top of `page-transition.js`.

## Setup

```bash
npm install
npx playwright install chromium
```

## Running

These tests need a real page to load — either your deployed site or a
local static file server. They do **not** need a build step (there isn't
one; this is a static site).

```bash
# against your deployed Worker
BASE_URL=https://web-service.yazeedayman.workers.dev npm test

# or against a plain static server for the checked-out repo
npx http-server . -p 8788 &
npm test
```

`playwright.config.js` defaults `BASE_URL` to `http://localhost:8788`.

## Hermetic by default

Every spec imports `test` from `tests/helpers/fixtures.js`, which swaps Supabase for the
in-memory fake in `tests/browser-harness/fake_supabase.js` (a signed-in user, no network,
no account; anything that isn't the local server is refused). Seed it per file or describe:

```js
const { test, expect } = require("./helpers/fixtures");
const { trade } = require("./helpers/trades");
test.use({ seed: { trades: [trade({ symbol: "ABCD", behavior_tags: ["fomo"] })] } });
```

`seed` is `{ trades, kv, local }` (rows for `trades` / `user_kv`, and localStorage values
seeded once). Keep it a single object: Playwright treats a 2-element array in `test.use`
as a `[value, options]` tuple and would silently drop the second trade.

With no `BASE_URL`, `playwright.config.js` starts `tests/helpers/static-server.js` itself.
To run against a deployed site instead, set `BASE_URL` (the fake backend still applies).

## What's covered

- `sidebar-nav.spec.js` -- the persistent sidebar staying in sync across SPA navigations.
- `journal-table.spec.js` -- the Journal rendered with known trades: rows, the one-line Tags
  cell and its "+N" card (row height / overflow), every filter, the Filters button badge,
  sort, URL state, paging, empty state.

Add the next screen the same way: seed trades, load the page, assert what is on screen.
The Python scripts in `tests/browser-harness/` are older print-only probes using the same fake.
