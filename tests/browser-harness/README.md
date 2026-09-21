Headless-Chromium checks that run the real pages against an in-memory fake
Supabase (no network, no account). Needs `pip install playwright` + a Chromium.
Edit the paths at the top of run.py, then e.g.:  python3 run.py trade_test.py
