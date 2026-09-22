import itertools
starts=["journal.html","daily.html","stats.html","settings.html","calculator.html","backtester.html","patterns.html","edge-analysis.html","practice.html","rewind.html","scanner.html","search.html","import-trades.html","live-trading.html"]
targets=[("Dashboard",'.sidebar-nav [data-tab="dashboard"], .sidebar-nav a[href="index.html"]'),("Day View",'.sidebar-nav [data-tab="dayview"], .sidebar-nav a[href="index.html#dayview"]'),("Reports",'.sidebar-nav [data-tab="reports"], .sidebar-nav a[href="index.html#reports"]')]
bad=0
for st in starts:
    for name,sel in targets:
        p2=ctx.new_page(); errs=[]
        p2.on("pageerror", lambda e: errs.append(str(e)))
        p2.on("console", lambda m: errs.append(m.text) if m.type=="error" and "Failed to load resource" not in m.text else None)
        p2.goto("http://localhost:8788/"+st); p2.wait_for_timeout(1500)
        loc=p2.locator(sel).first
        if not loc.count(): print("no link", st, name); p2.close(); continue
        loc.click(); p2.wait_for_timeout(3200)
        lu=p2.inner_text("#last-updated") if p2.locator("#last-updated").count() else "MISSING"
        txt=p2.inner_text("body")
        ok = lu.startswith("Through") and "Couldn't load" not in txt and not errs and p2.locator("#load-banner").count()==0
        if not ok:
            bad+=1; print("FAIL", st, "->", name, "| last-updated:", lu, "| errs:", errs[:2], "| banner:", p2.locator("#load-banner").count())
        p2.close()
print("combos checked:", len(starts)*len(targets), "failures:", bad)
