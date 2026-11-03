Headless-Chromium checks that run the real pages against an in-memory fake
Supabase (no network, no account). Needs `pip install playwright` + a Chromium.
Paths are relative to the repo (serves ./public, loads ./fake_supabase.js), so e.g.:  python3 tests/browser-harness/run.py tests/browser-harness/trade_test.py
