import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localDB} from '../src/local-db.js';
import {Inventory} from '../src/inventory.js';
import {stockConfig,stockDecision} from '../src/stock-policy.js';
import {runStockSync,stockStates} from '../src/stock-sync.js';
import {marketStocks} from '../src/market-stock.js';
import {handleApi} from '../src/api.js';
const MIN=60000,start=Date.parse('2026-10-14T12:00:00Z');
const settings={enabled:true,target:'campaign:149189839',percent:35,thresholdPercent:30,intervalMinutes:10,zeroHours:5};
test('35% rounding and hysteresis match the requested 30, 23, 38, 20, 16 examples',()=>{
  assert.equal(stockDecision(settings,{}, {total:30,current:1,now:start}).count,11);
  assert.equal(stockDecision(settings,{}, {total:10,current:1,now:start}).count,4);
  const old={baselineTotal:30,lastSentCount:11};
  for(const total of [23,38])assert.equal(stockDecision(settings,old,{total,current:11,now:start}).count,null);
  for(const [total,count] of [[20,7],[16,6],[39,14]])assert.equal(stockDecision(settings,old,{total,current:11,now:start}).count,count);
  assert.equal(stockDecision(settings,old,{total:1,current:11,now:start}).count,1);
});
test('small fluctuations do not move the baseline; depleted listing refills on the next check',()=>{
  let previous={baselineTotal:30,lastSentCount:11};
  for(const total of [29,25,23,38]){const d=stockDecision(settings,previous,{total,current:11,now:start});assert.equal(d.count,null);previous=d.state;}
  assert.equal(previous.baselineTotal,30);
  assert.equal(stockDecision(settings,previous,{total:20,current:11,now:start}).count,7);
  assert.equal(stockDecision(settings,previous,{total:30,current:0,now:start}).count,11);
  assert.equal(stockDecision(settings,previous,{total:30,current:7,now:start}).count,11);
});
test('zero requires five continuous hours, positive stock and long gaps restart the timer',()=>{
  let previous={baselineTotal:30,lastSentCount:11};
  for(let i=0;i<30;i++){const d=stockDecision(settings,previous,{total:0,current:11,now:start+i*10*MIN});assert.equal(d.count,null);previous=d.state;}
  assert.equal(stockDecision(settings,previous,{total:0,current:11,now:start+300*MIN}).count,0);
  const positive=stockDecision(settings,previous,{total:30,current:11,now:start+300*MIN});assert.equal(positive.state.zeroSince,null);
  assert.equal(stockDecision(settings,positive.state,{total:0,current:11,now:start+310*MIN}).state.zeroSince,start+310*MIN);
  const gap=stockDecision(settings,previous,{total:0,current:11,now:start+400*MIN});assert.equal(gap.count,null);assert.equal(gap.state.zeroSince,start+400*MIN);
});
test('rules reject invalid numbers, missing target and too-frequent polling',()=>{
  for(const input of [{percent:0},{percent:101},{percent:NaN},{intervalMinutes:1},{thresholdPercent:0},{zeroHours:-1},{target:'warehouse:bad'},{enabled:true,target:''}])assert.throws(()=>stockConfig({...settings,...input}));
  assert.equal(stockConfig().enabled,false);
});
async function setup(t,{enabled=true,provider='mke',target=settings.target}={}){
  const env={DB:localDB(),DATA_ENCRYPTION_KEY:Buffer.alloc(32,1).toString('base64'),YANDEX_API_KEY:'test-market',YANDEX_BUSINESS_ID:'216918278',YANDEX_CAMPAIGN_ID:'149189839',MKE_API_KEY:'test-mke',ROBOTICVN_API_KEY:'test-robotic',APP_PASSWORD:'test-password-long-enough'};t.after(()=>env.DB.close());
  const store=new Inventory(env),input={name:'Test',offerId:'SKU',kind:'account',slip:'Local instructions',activateTill:'2099-01-01',supplierKind:'code',supplierEnabled:true,supplierProductId:provider==='mke'?8:'rvn:prod:var:usd',supplierProvider:provider,stockSync:{...settings,enabled,target}},category=await store.saveCategory(input);
  const calls=[],writes=[],remote={stock:30,current:1,failSupplier:false,failWrite:false};
  const fetcher=async(url,options={})=>{
    const u=new URL(url),data=JSON.parse(options.body||'{}');calls.push({url:u,options,data});
    if(u.hostname==='api.technysoft.com'){if(remote.failSupplier)throw new Error('offline');return Response.json([{id:8,stock:remote.stock,instant:true,price_usd:1}]);}
    if(u.hostname==='api.roboticvn.com'){if(remote.failSupplier)throw new Error('offline');return Response.json({data:{id:'prod',in_stock:true,variants:[{id:'var',in_stock:remote.stock>0,available_quantity:remote.stock,prices:{usd:1}}]}});}
    if(u.pathname==='/v3/businesses/216918278/warehouses')return Response.json({result:{warehouses:[{id:45,name:'DBS',models:[{placementType:'DBS',apiAvailability:'AVAILABLE'}]}]}});
    if(u.pathname.includes('/offers/stocks')){
      if(options.method==='PUT'||u.pathname.endsWith('/update')){if(remote.failWrite)return Response.json({status:'ERROR'},{status:503});const count=data.skus?.[0].items[0].count??data.skuItems?.[0].count;writes.push(count);remote.current=count;return Response.json({status:'OK'});}
      const offers=[{offerId:'SKU',stocks:[{type:'AVAILABLE',count:remote.current},{type:'FREEZE',count:99}]}];
      return Response.json({result:target.startsWith('warehouse')?{partnerWarehouseId:45,offers}:{warehouses:[{warehouseId:45,offers}]}});
    }
    throw new Error('Unexpected endpoint '+url);
  };
  return {env,store,input,category,remote,fetcher,calls,writes};
}
test('disabled sync does not call suppliers or Market',async t=>{const x=await setup(t,{enabled:false});assert.deepEqual(await runStockSync(x.env,x.fetcher,start),{checked:0,updated:0});assert.equal(x.calls.length,0);});

test('active scheduler lease prevents overlap and expired lease recovers',async t=>{
  const x=await setup(t);
  await x.store.q("INSERT INTO jobs(name,value,updated_at) VALUES('stock_sync_lock','another-run',?)",new Date(start).toISOString()).run();
  assert.deepEqual(await runStockSync(x.env,x.fetcher,start+5*MIN),{busy:true});assert.equal(x.calls.length,0);
  assert.deepEqual(await runStockSync(x.env,x.fetcher,start+11*MIN),{checked:1,updated:1});assert.deepEqual(x.writes,[11]);
  assert.equal(await x.store.q("SELECT name FROM jobs WHERE name='stock_sync_lock'").first(),null);
});
test('scheduler persists ten-minute cadence and applies threshold changes',async t=>{
  const x=await setup(t);await runStockSync(x.env,x.fetcher,start);assert.deepEqual(x.writes,[11]);
  const count=x.calls.length;await runStockSync(x.env,x.fetcher,start+MIN);assert.equal(x.calls.length,count);
  x.remote.stock=23;await runStockSync(x.env,x.fetcher,start+10*MIN);assert.deepEqual(x.writes,[11]);
  x.remote.stock=20;await runStockSync(x.env,x.fetcher,start+20*MIN);assert.deepEqual(x.writes,[11,7]);
  assert.equal((await stockStates(x.store))[x.category.id].baselineTotal,20);
});
test('own available pool contributes to quantity; reserved and blocked units do not',async t=>{
  const x=await setup(t);x.remote.stock=0;
  await x.store.saveItems({categoryId:x.category.id,items:[{kind:'account',login:'one',password:'p'},{kind:'account',login:'two',password:'p'}]});
  await x.store.q("UPDATE inventory SET status='blocked' WHERE id=(SELECT id FROM inventory ORDER BY id LIMIT 1)").run();
  await runStockSync(x.env,x.fetcher,start);assert.equal(x.remote.current,1);const s=(await stockStates(x.store))[x.category.id];assert.equal(s.observedTotal,1);assert.equal(s.localStock,1);assert.equal(s.zeroSince,null);
});
test('supplier error is not zero, resets absence tracking and does not retry each minute',async t=>{
  const x=await setup(t);x.remote.stock=0;await runStockSync(x.env,x.fetcher,start);
  x.remote.failSupplier=true;await runStockSync(x.env,x.fetcher,start+10*MIN);assert.deepEqual(x.writes,[]);assert.equal((await stockStates(x.store))[x.category.id].zeroSince,null);
  const count=x.calls.length;await runStockSync(x.env,x.fetcher,start+11*MIN);assert.equal(x.calls.length,count);
  x.remote.failSupplier=false;await runStockSync(x.env,x.fetcher,start+20*MIN);assert.equal((await stockStates(x.store))[x.category.id].zeroSince,start+20*MIN);
});
test('confirmed zero is sent once after five hours and a return to stock restores at next check',async t=>{
  const x=await setup(t);x.remote.stock=0;
  for(let i=0;i<=30;i++)await runStockSync(x.env,x.fetcher,start+i*10*MIN);
  assert.deepEqual(x.writes,[0]);await runStockSync(x.env,x.fetcher,start+310*MIN);assert.deepEqual(x.writes,[0]);
  x.remote.stock=10;await runStockSync(x.env,x.fetcher,start+320*MIN);assert.deepEqual(x.writes,[0,4]);
});
test('failed stock write does not advance success baseline; next check reconciles before writing',async t=>{
  const x=await setup(t);x.remote.failWrite=true;await runStockSync(x.env,x.fetcher,start);assert.equal((await stockStates(x.store))[x.category.id].lastSentAt,undefined);
  x.remote.failWrite=false;x.remote.current=11;await runStockSync(x.env,x.fetcher,start+10*MIN);assert.deepEqual(x.writes,[]);assert.equal((await stockStates(x.store))[x.category.id].baselineTotal,30);
});
test('ROBOTICVN reads only selected product; v3 write includes exact warehouse and SKU',async t=>{
  const x=await setup(t,{provider:'roboticvn',target:'warehouse:45'});await runStockSync(x.env,x.fetcher,start);assert.deepEqual(x.writes,[11]);
  const supplier=x.calls.filter(c=>c.url.hostname==='api.roboticvn.com');assert.equal(supplier.length,1);assert.equal(supplier[0].url.pathname,'/api/v2/products/prod');
  const write=x.calls.find(c=>c.url.pathname.endsWith('/stocks/update'));assert.deepEqual(write.data.skuItems,[{sku:'SKU',partnerWarehouseId:45,count:11,updatedAt:new Date(start).toISOString()}]);
});
test('missing supplier count or ambiguous Market stock never publishes zero',async t=>{
  const x=await setup(t);x.remote.stock=null;await runStockSync(x.env,x.fetcher,start);assert.deepEqual(x.writes,[]);
  await assert.rejects(marketStocks(x.env,async()=>Response.json({result:{warehouses:[]}})).read(settings.target,'SKU'),/единственный склад/);
  await assert.rejects(marketStocks(x.env,async()=>Response.json({result:{partnerWarehouseId:99,offers:[]}})).read('warehouse:45','SKU'),/другому складу/);
});

test('Market FIT includes reservations; available stock is FIT minus confirmed FREEZE',async t=>{
  const x=await setup(t);
  const read=stocks=>marketStocks(x.env,async()=>Response.json({result:{partnerWarehouseId:45,offers:[{offerId:'SKU',stocks}]}})).read('warehouse:45','SKU');
  assert.equal(await read([{type:'FIT',count:12},{type:'FREEZE',count:3}]),9);
  assert.equal(await read([{type:'FIT',count:12},{type:'FREEZE',count:0}]),12);
  assert.equal(await read([{type:'AVAILABLE',count:8},{type:'FIT',count:12},{type:'FREEZE',count:3}]),8);
  await assert.rejects(read([{type:'FIT',count:12}]),/не подтвердил/);
  await assert.rejects(read([{type:'FIT',count:2},{type:'FREEZE',count:3}]),/не подтвердил/);
  await assert.rejects(read([{type:'AVAILABLE',count:-1},{type:'FIT',count:12},{type:'FREEZE',count:0}]),/не подтвердил/);
});
test('turning sync off during remote reads prevents the final write',async t=>{
  const x=await setup(t);const fetcher=async(u,o)=>{const r=await x.fetcher(u,o);if(new URL(u).hostname==='api.technysoft.com')await x.store.saveCategory({...x.input,id:x.category.id,stockSync:{...settings,enabled:false}});return r;};
  await runStockSync(x.env,fetcher,start);assert.deepEqual(x.writes,[]);
});
test('read-only preview uses authenticated API and never publishes',async t=>{
  const x=await setup(t,{target:'warehouse:45'}),request=new Request('https://test/api/stock-sync/preview',{method:'POST',headers:{'Content-Type':'application/json','X-App-Request':'digital-goods','X-App-Password':x.env.APP_PASSWORD},body:JSON.stringify({categoryId:x.category.id})});
  const r=await handleApi(request,x.env,x.fetcher);assert.equal(r.status,200);assert.equal((await r.json()).count,11);assert.deepEqual(x.writes,[]);
});
test('warehouse discovery filters DBS availability and supports old campaign API',async t=>{
  const x=await setup(t);
  assert.deepEqual(await marketStocks(x.env,x.fetcher).targets(),[{id:'warehouse:45',name:'DBS · №45'}]);
  const calls=[];const api=marketStocks(x.env,async(u,o)=>{calls.push(JSON.parse(o.body));return u.includes('/v3/')?Response.json({status:'ERROR'},{status:400}):Response.json({result:{warehouses:[{id:90,name:'Old',campaignId:149189839},{id:91,name:'Wrong',campaignId:1}]}});});
  assert.deepEqual(await api.targets(),[{id:'campaign:149189839',name:'Old · магазин 149189839',warehouseId:90}]);assert.deepEqual(calls[1],{campaignIds:[149189839]});
});
