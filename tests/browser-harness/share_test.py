seed = "localStorage.setItem('trade.log:journal_entries', JSON.stringify({T1:{plan_stop:4.8,plan_target:5.6,setup:'Breakout',mistakes:['Chased entry'],followed_rules:true,notes:'Waited for <b>reclaim</b>',updated:'x'}}))"
pg.add_init_script("if(!localStorage.getItem('trade.log:journal_entries')){"+seed+"}")
pg.goto("http://localhost:8788/trade.html?id=T1"); pg.wait_for_timeout(2500)
html = pg.evaluate("""async()=>{const t=await window.fetchTradeDetail('T1'); return window.TradeLogShare.buildTradeSharePage(t)}""")
i=html.find("Trader's journal"); print(html[i-30:i+900] if i>=0 else "NO JOURNAL CARD")
print("escaped notes:", "&lt;b&gt;reclaim" in html)
pg.goto("http://localhost:8788/journal.html"); pg.wait_for_timeout(2500)
html2 = pg.evaluate("""async()=>{const r=await window.fetchTradesIndex(); return window.TradeLogShare.buildSetSharePage(r,{})}""")
import re
print(re.findall(r"<th>[^<]*</th>", html2))
print([re.sub(r"<[^>]+>"," ",x).split() for x in re.findall(r"<tr>.*?</tr>", html2, re.S)][1:3])
