import sys, json, subprocess, time, os
os.environ["PLAYWRIGHT_BROWSERS_PATH"]="/opt/pw-browsers"
from playwright.sync_api import sync_playwright
fake = open("/home/claude/t/fake_supabase.js").read()
srv = subprocess.Popen(["python3","-m","http.server","8788","-d","/home/claude/ws"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(1)
errors=[]
def setup(ctx):
    ctx.route(lambda u: not u.startswith("http://localhost"), lambda r: r.abort())
    ctx.route("**/@supabase/supabase-js**", lambda r: r.fulfill(body=fake, content_type="application/javascript"))
    ctx.route("**/lightweight-charts**", lambda r: r.fulfill(body="(function(){const mk=()=>new Proxy(function(){},{get:(t,k)=>k===Symbol.toPrimitive?()=>0:mk(),apply:()=>mk(),construct:()=>mk()});window.LightweightCharts=new Proxy({},{get:(t,k)=>mk()});})()", content_type="application/javascript"))
try:
  with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width":1300,"height":1000}, service_workers="block")
    setup(ctx)
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append("PAGEERROR: "+str(e)))
    pg.on("console", lambda m: errors.append("CONSOLE."+m.type+": "+m.text) if m.type=="error" else None)
    exec(open(sys.argv[1]).read())
    b.close()
finally:
    srv.terminate()
print("\n".join(errors) or "no errors")
