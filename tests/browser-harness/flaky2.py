for name,url,sel in [("journal","journal.html","tbody tr"),("stats","stats.html","#journal-insights"),("patterns","patterns.html","body")]:
    p2=ctx.new_page(); p2.add_init_script('window.__fail={n:3,kind:"fetch"};')
    p2.on("pageerror", lambda e: errors.append("PAGEERROR "+str(e)))
    p2.goto("http://localhost:8788/"+url); p2.wait_for_timeout(9000)
    print(name, "rows/elements:", p2.locator(sel).count(), "| failures injected:", p2.evaluate("window.__failCount||0"), "| text has error:", "Couldn't" in p2.inner_text("body"))
    p2.close()
