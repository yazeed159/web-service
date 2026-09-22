import time
def run(name, plan, sess=None, url="index.html#reports", wait=14000, after=None):
    init = "window.__fail=%s;" % json.dumps(plan) + ("window.__failSession=%s;" % json.dumps(sess) if sess else "")
    p2 = ctx.new_page()
    p2.on("pageerror", lambda e: errors.append(name+" PAGEERROR: "+str(e)))
    p2.add_init_script(init)
    t0=time.time()
    p2.goto("http://localhost:8788/"+url)
    ok=False
    for _ in range(int(wait/500)):
        p2.wait_for_timeout(500)
        lu = p2.inner_text("#last-updated") if p2.locator("#last-updated").count() else ""
        if lu.startswith("Through"):
            ok=True; break
        if p2.locator("#load-banner").count(): break
    banner = p2.locator("#load-banner").inner_text().replace("\n"," ") if p2.locator("#load-banner").count() else None
    print(f"{name}: loaded={ok} after={time.time()-t0:.1f}s banner={banner!r} queries_failed={p2.evaluate('window.__failCount||0')} refreshed={p2.evaluate('window.__refreshed||0')} url={p2.url.split('/')[-1][:30]}")
    if after: after(p2)
    p2.close()
run("A network x3", {"n":3,"kind":"fetch"})
run("B jwt expired x2", {"n":2,"kind":"jwt"})
run("C 503 x2", {"n":2,"kind":"503"})
run("D thrown x2", {"n":2,"kind":"throw"})
run("E getSession err x2", {"n":0}, {"n":2})
def recover(p2):
    p2.evaluate("window.__fail.n=0"); p2.click("[data-retry]"); p2.wait_for_timeout(2500)
    print("   after clicking Retry now -> banner gone:", p2.locator("#load-banner").count()==0, "| reports text ok:", "Couldn't load" not in p2.inner_text("#tab-reports"), "| last-updated:", p2.inner_text("#last-updated"))
run("F long outage then Retry button", {"n":40,"kind":"fetch"}, wait=20000, after=recover)
