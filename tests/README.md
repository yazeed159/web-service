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

## Auth

If any of these pages redirect to a login screen for a signed-out visitor,
these tests need a logged-in session — record one once with Playwright's
`codegen --save-storage=auth.json` against a real login, then run with:

```bash
STORAGE_STATE=auth.json npm test
```

The tests themselves don't touch trade data (they never assert on rows in
the Journal table, symbols, or anything else that depends on which trades
happen to be logged) — only the sidebar's nav highlight and status label,
which are the same regardless of what account is signed in.

## What's covered vs. not

These are deliberately narrow: they exist to catch a *specific* class of
bug (a per-page bit of the persistent sidebar going stale across an SPA
transition), not to be a general test suite for the site. If you add a new
page-specific region to the sidebar or topbar later (see the checklist
comment in `page-transition.js`), add a case here alongside it.
