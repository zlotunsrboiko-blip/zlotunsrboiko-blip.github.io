import {Inventory} from './inventory.js';
import {stockConfig,stockDecision,StockError} from './stock-policy.js';
import {supplierStock} from './supplier-stock.js';
import {marketStocks} from './market-stock.js';
export {StockError};
const signature=c=>JSON.stringify([c.offer_id,c.item_kind,c.supplier_enabled,c.supplier_provider,c.supplier_product_id,c.stock_sync]);
export async function stockStates(store){
  const rows=(await store.q("SELECT name,value FROM jobs WHERE name LIKE 'stock-state:%'").all()).results;
  return Object.fromEntries(rows.map(r=>{try{return [r.name.slice(12),JSON.parse(r.value)];}catch{return [r.name.slice(12),{}];}}));
}
export async function runStockSync(env,fetcher=fetch,now=Date.now()){
  if(!env.DB||!env.YANDEX_API_KEY)return {checked:0,updated:0};
  const store=new Inventory(env),categories=(await store.categories()).filter(c=>c.stock_sync.enabled&&!c.reusable);
  if(!categories.length)return {checked:0,updated:0};
  const stamp=new Date(now).toISOString(),lock=crypto.randomUUID();
  const claimed=await store.q("INSERT INTO jobs(name,value,updated_at) VALUES('stock_sync_lock',?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE jobs.updated_at<?",lock,stamp,new Date(now-600000).toISOString()).run();
  if(!claimed.meta.changes)return {busy:true};
  const market=marketStocks(env,fetcher),cache=new Map(),states=await stockStates(store);let checked=0,updated=0;
  const save=(id,state)=>store.q('INSERT INTO jobs(name,value,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at','stock-state:'+id,JSON.stringify(state),stamp).run();
  try{
    const due=categories.filter(c=>states[c.id]?.signature!==signature(c)||!(states[c.id]?.nextCheckAt>now)).sort((a,b)=>(states[a.id]?.nextCheckAt||0)-(states[b.id]?.nextCheckAt||0));
    // Bound D1 queries and network calls alongside the existing order automation.
    for(const c of due.slice(0,3)){
      const config=stockConfig(c.stock_sync),sig=signature(c),old=states[c.id]?.signature===sig?states[c.id]:{},nextCheckAt=now+config.intervalMinutes*60000;
      let state={...old,signature:sig,nextCheckAt};checked++;
      // Persist the schedule before network access, so errors never cause per-minute supplier polling.
      await save(c.id,state);
      try{
        const local=Number((await store.q("SELECT COUNT(*) AS count FROM inventory WHERE category_id=? AND kind=? AND status='available'",c.id,c.item_kind).first()).count);
        const supplier=await supplierStock(env,c,fetcher,cache),total=local+supplier.stock;
        const current=await market.read(config.target,c.offer_id),decision=stockDecision(config,old,{total,current,now});
        state={...state,...decision.state,localStock:local,supplierStock:supplier.stock};
        const latest=await store.categoryByOffer(c.offer_id);
        if(!latest||!latest.stock_sync.enabled||signature(latest)!==sig)continue;
        if(decision.count!==null){
          await market.write(config.target,c.offer_id,decision.count,now);
          state={...state,baselineTotal:total,lastSentCount:decision.count,lastSentAt:now,currentMarket:decision.count};updated++;
          await store.audit(c.id,`stock_updated:count=${decision.count},source=${total},reason=${state.reason}`);
        }
      }catch(e){state={...state,lastCheckedAt:now,zeroSince:null,error:e instanceof StockError||e.name==='SupplierError'?e.message:'Не удалось проверить остатки. Количество в Маркете не подтверждено.',reason:'error'};}
      await save(c.id,state);
    }
    return {checked,updated};
  }finally{await store.q("DELETE FROM jobs WHERE name='stock_sync_lock' AND value=?",lock).run();}
}
