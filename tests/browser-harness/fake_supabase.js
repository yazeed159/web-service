(function(){
  const db = window.__db = { user_kv: [], trades: [
    {id:"T1",symbol:"ABCD",trade_date:"2026-09-18",entry_time:"09:35:00",side:"long",shares:100,entry_price:5.00,exit_price:5.40,pnl_after_comm:38,pnl_before_comm:40,commission:2,bars:Array.from({length:80},(_,i)=>({t:"2026-09-18 09:"+String(30+Math.floor(i/60)).padStart(2,"0")+":"+String(i%60).padStart(2,"0"),o:5+i*0.005,h:5.1+i*0.005,l:4.9+i*0.005,c:5.02+i*0.005,v:1000+i})),verdict:"good",win:true},
    {id:"T2",symbol:"WXYZ",trade_date:"2026-09-18",entry_time:"10:05:00",side:"long",shares:200,entry_price:3.00,exit_price:2.90,pnl_after_comm:-22,pnl_before_comm:-20,commission:2,bars:Array.from({length:80},(_,i)=>({t:"2026-09-18 09:"+String(30+Math.floor(i/60)).padStart(2,"0")+":"+String(i%60).padStart(2,"0"),o:5+i*0.005,h:5.1+i*0.005,l:4.9+i*0.005,c:5.02+i*0.005,v:1000+i})),verdict:"bad",win:false},
    {id:"T3",symbol:"QQQQ",trade_date:"2026-09-21",entry_time:"09:40:00",side:"short",shares:50,entry_price:10.00,exit_price:9.80,pnl_after_comm:9,pnl_before_comm:10,commission:1,bars:Array.from({length:80},(_,i)=>({t:"2026-09-18 09:"+String(30+Math.floor(i/60)).padStart(2,"0")+":"+String(i%60).padStart(2,"0"),o:5+i*0.005,h:5.1+i*0.005,l:4.9+i*0.005,c:5.02+i*0.005,v:1000+i})),verdict:"good",win:true},
  ], trade_details: [{trade_id:'T1',indicators:{},verdict:'ok'},{trade_id:'T2'},{trade_id:'T3'}] };
  const session = { user: { id: "u1", email: "t@t.com", created_at: "2026-01-01" } };
  function q(table){
    let rows = db[table] || []; let filt = []; let op="select"; let payload=null; let single=false;
    const api = {
      select(){ return api; }, order(){ return api; },
      eq(k,v){ filt.push([k,v]); return api; },
      maybeSingle(){ single=true; return api; },
      upsert(p){ op="upsert"; payload=p; return api; },
      delete(){ op="delete"; return api; },
      then(res, rej){
        let out;
        const f = r => filt.every(([k,v])=>r[k]===v);
        const F = window.__fail;
        if (F && F.n>0 && (F.table||'trades')===table){
          F.n--; window.__failCount=(window.__failCount||0)+1;
          if (F.kind==='throw') return new Promise((_,rj)=>setTimeout(()=>rj(new TypeError('Failed to fetch')),50)).then(res, rej);
          const e = F.kind==='jwt' ? {message:'JWT expired',code:'PGRST301',status:401}
                  : F.kind==='503' ? {message:'Service Unavailable',status:503}
                  : F.kind==='rls' ? {message:'permission denied for table trades',code:'42501'}
                  : {message:'TypeError: Failed to fetch'};
          return new Promise(r=>setTimeout(()=>r({data:null,error:e,status:e.status}),50)).then(res, rej);
        }
        if(op==="select"){ const d = rows.filter(f); out = {data: single ? (d[0]||null) : d, error:null}; }
        else if(op==="upsert"){ const i = rows.findIndex(r=>r.user_id===payload.user_id && r.key===payload.key); if(i>=0) rows[i]=payload; else rows.push(payload); db[table]=rows; out={data:null,error:null}; }
        else { db[table]=rows.filter(r=>!f(r)); out={data:null,error:null}; }
        return new Promise(r=>setTimeout(()=>r(out),250)).then(res, rej);
      }
    };
    return api;
  }
  window.supabase = { createClient(){ return {
    auth:{ getSession: async()=>{ const F=window.__failSession; if(F&&F.n>0){F.n--; return {data:{session:null},error:{message:'Failed to fetch'}};} return {data:{session}}; }, refreshSession: async()=>{ window.__refreshed=(window.__refreshed||0)+1; return {data:{session}}; }, onAuthStateChange(){ return {data:{subscription:{unsubscribe(){}}}}; }, signOut: async()=>({}) },
    from: q } } };
})();
