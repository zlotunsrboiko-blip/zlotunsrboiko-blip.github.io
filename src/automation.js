import {handleApi} from './api.js';
import {Inventory,deliveryText} from './inventory.js';
import {syncSheets} from './sheets.js';
import {supplierBuy,parseSupplierCredential} from './supplier.js';
const enabled=value=>value===true||String(value).toLowerCase()==='true';
const reason=error=>String(error?.message||'Неизвестная ошибка').replace(/\s+/g,' ').slice(0,300);
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
    const seen=new Set();
    async function prepareOrder(order){
      const external=[];
      for(const item of order.items||[]){
        const quantity=Number(item.count??item.quantity),category=await store.categoryByOffer(item.offerId||'');
        if(!category)continue;
        const stock=await store.q("SELECT COUNT(*) AS count FROM inventory WHERE category_id=? AND kind=? AND status='available'",category.id,category.item_kind).first();
        if(Number(stock.count)>=quantity||!category.supplier_enabled)continue;
        const bought=await supplierBuy(env,{productId:category.supplier_product_id,quantity,idempotencyKey:`ym-${order.id??order.orderId}-${item.id}`},fetcher);
        const secrets=bought.texts.map(value=>parseSupplierCredential(category.item_kind,value));
        external.push({id:item.id,codes:secrets.map(deliveryText),secrets,slip:category.slip,activate_till:category.activate_till});
        await store.audit(String(order.id??order.orderId),`supplier_purchased:order=${bought.supplierOrderId},product=${category.supplier_product_id},qty=${quantity}${bought.idempotentReplay?',replay=true':''}`);
      }
      return store.prepare(order,external.length?external:null);
    }
    async function processOrder(order){
      if(!enabled(env.AUTO_DELIVERY)||order.fake||order.status!=='PROCESSING'||!['ACTIVATION_CODE','EMAIL'].includes(order.delivery?.digitalGoods?.type))return;
      const id=String(order.id??order.orderId);if(seen.has(id))return;seen.add(id);
      try{
        const saved=await store.prepared(id);
        if(saved&&saved.state!=='prepared')return;
        if(!saved)await prepareOrder(order);
        await api('/api/deliver',{orderId:id});delivered++;
      }catch(error){failures++;await store.audit(id,`auto_delivery_failed:${reason(error)}`);}
    }
    let page=null,passes=0;
    do{
      const result=await api('/api/orders?'+new URLSearchParams({fake:'false',...(page?{pageToken:page}:{})}));
      for(const order of result.orders)await processOrder(order);
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
    do{const r=await api('/api/history?'+new URLSearchParams({from,to,...(page?{pageToken:page}:{})}));for(const order of r.orders)await processOrder(order);page=r.nextPageToken;passes++;}while(page&&passes<20);
    if(page)throw new Error('History pagination limit reached');
    // A manual reserve or a transient list lag must never require a second confirmation.
    const ready=(await store.q("SELECT order_id FROM deliveries WHERE state='prepared' LIMIT 50").all()).results;
    for(const row of ready){if(seen.has(row.order_id))continue;try{await api('/api/deliver',{orderId:row.order_id});delivered++;}catch(error){failures++;await store.audit(row.order_id,`auto_delivery_failed:${reason(error)}`);}}
    try{await syncSheets(store,env,fetcher);}catch(error){failures++;await store.audit('automation',`google_sync_failed:${reason(error)}`);}
    await store.audit('automation',`finished:delivered=${delivered},issues=${failures}`);
    return {ok:true,delivered,failures};
  }catch(error){await store.audit('automation',`market_sync_failed:${reason(error)}`);return {ok:false};}
  finally{await store.q("DELETE FROM jobs WHERE name='automation_lock' AND value=?",lock).run();}
}
