import {handleApi} from './api.js';
import {Inventory} from './inventory.js';
import {syncSheets} from './sheets.js';
export async function runAutomation(env,fetcher=fetch){
  if(!env.DB||!env.YANDEX_API_KEY)return {configured:false};
  const store=new Inventory(env),t=new Date().toISOString(),lock=crypto.randomUUID();
  const locked=await store.q(`INSERT INTO jobs(name,value,updated_at) VALUES('automation_lock',?,?)
    ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    WHERE jobs.updated_at<?`,lock,t,new Date(Date.now()-180000).toISOString()).run();
  if(!locked.meta.changes)return {busy:true};
  let failures=0,delivered=0;
  async function api(path,data){
    const r=await handleApi(new Request('https://internal.local'+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-App-Request':'digital-goods','X-App-Password':encodeURIComponent(env.APP_PASSWORD||'')},body:data===undefined?undefined:JSON.stringify(data)}),env,fetcher);
    const result=await r.json();if(!r.ok)throw new Error('Internal operation failed');return result;
  }
  try{
    let page=null,passes=0;
    do{
      const result=await api('/api/orders?'+new URLSearchParams({fake:'false',...(page?{pageToken:page}:{})}));
      for(const order of result.orders){
        if(env.AUTO_DELIVERY!=='true'||order.fake||!['ACTIVATION_CODE','EMAIL'].includes(order.delivery?.digitalGoods?.type))continue;
        const id=String(order.id??order.orderId);
        try{
          const saved=await store.prepared(id);
          if(saved&&saved.state!=='prepared')continue;
          if(!saved)await api('/api/pool/prepare',{orderId:id});
          await api('/api/deliver',{orderId:id});delivered++;
        }catch{failures++;await store.audit(id,'auto_delivery_needs_attention');}
      }
      page=result.nextPageToken;passes++;
    }while(page&&passes<20);
    if(page)throw new Error('Processing pagination limit reached');
    // Reconcile every unresolved delivery by exact order ID, even if it is older than the recent-history window.
    const pending=(await store.q("SELECT order_id FROM deliveries d JOIN orders o ON o.id=d.order_id WHERE d.state IN ('sending','uncertain','accepted') AND o.status NOT IN ('DELIVERED','CANCELLED') LIMIT 50").all()).results;
    for(const p of pending){
      const data=await api('/api/history?orderId='+encodeURIComponent(p.order_id));
      if(data.orders[0]?.status==='DELIVERED')await store.outcome(p.order_id,'accepted');
    }
    // Track externally fulfilled/cancelled orders as well. Recent orders are upserted, never appended twice.
    const from=new Date(Date.now()-29*86400000).toISOString().slice(0,10),to=t.slice(0,10);
    page=null;passes=0;
    do{const r=await api('/api/history?'+new URLSearchParams({from,to,...(page?{pageToken:page}:{})}));page=r.nextPageToken;passes++;}while(page&&passes<20);
    if(page)throw new Error('History pagination limit reached');
    try{await syncSheets(store,env,fetcher);}catch{failures++;await store.audit('automation','google_sync_failed');}
    await store.audit('automation',`finished:delivered=${delivered},issues=${failures}`);
    return {ok:true,delivered,failures};
  }catch{await store.audit('automation','market_sync_failed');return {ok:false};}
  finally{await store.q("DELETE FROM jobs WHERE name='automation_lock' AND value=?",lock).run();}
}
