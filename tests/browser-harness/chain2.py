p2=ctx.new_page(); errs=[]
p2.on("pageerror", lambda e: errs.append("PAGEERROR "+str(e)+" :: "+(getattr(e,"stack","") or "")[:600]))
p2.on("console", lambda m: errs.append(m.text[:200]) if m.type=="error" and "Failed to load resource" not in m.text else None)
p2.goto("http://localhost:8788/journal.html"); p2.wait_for_timeout(1500)
steps=[('a[href="calculator.html"]',"calculator"),('a[href="settings.html"]',"settings"),('a[href="patterns.html"]',"patterns"),('a[href="index.html#reports"]',"reports"),('a[href="journal.html"]',"journal"),('a[href="index.html#dayview"]',"dayview"),('a[href="index.html"]',"dashboard")]
for sel,name in steps:
    loc=p2.locator(".sidebar-nav "+sel)
    if loc.count()==0:
        tab={"reports":"reports","dayview":"dayview","dashboard":"dashboard"}.get(name)
        loc=p2.locator(f'.sidebar-nav [data-tab="{tab}"]') if tab else loc
    n=len(errs); loc.first.click(); p2.wait_for_timeout(2500)
    print(f"{name:10} title={p2.inner_text('#page-title'):22} url={p2.url.split('/')[-1]:22} new_errs={len(errs)-n} banner={p2.locator('#load-banner').count()}")
    for e in errs[n:]: print("     ", e)
print("--- back button ---")
for i in range(5):
    n=len(errs); p2.go_back(); p2.wait_for_timeout(2200)
    print(f"back {i+1}: title={p2.inner_text('#page-title') if p2.locator('#page-title').count() else '?':22} url={p2.url.split('/')[-1]:22} new_errs={len(errs)-n}")
