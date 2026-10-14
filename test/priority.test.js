import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localDB} from '../src/local-db.js';
import {Inventory} from '../src/inventory.js';
import {runAutomation} from '../src/automation.js';
import {procure} from '../src/procurement.js';
import {makeMarketMock} from './fixtures.js';
async function setup(t,priority='pool_first'){
  const env={DB:localDB(),DATA_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('base64'),YANDEX_API_KEY:'demo-key',YANDEX_BUSINESS_ID:'216918278',YANDEX_CAMPAIGN_ID:'149189839',APP_PASSWORD:'test-long-password',AUTO_DELIVERY:'true',MKE_API_KEY:'test-only'};t.after(()=>env.DB.close());
  const store=new Inventory(env),market=makeMarketMock();market.orders.splice(1);
  const input={name:'Accounts and CDK',offerId:'DIGITAL-84729105',kind:'account',slip:'Account instruction',activateTill:'2099-01-01',supplierEnabled:true,supplierProvider:'mke',supplierProductId:8,supplierKind:'code',supplierSlip:'Activate CDK here',deliveryPriority:priority};
  const category=await store.saveCategory(input);await store.saveItems({categoryId:category.id,items:[{kind:'account',login:'manual@example.test',password:'test-password'}]});
  const remote={stock:10,balance:100,pending:false,calls:[]};
  const fetcher=async(u,o={})=>{
    const url=new URL(u);if(url.hostname==='api.partner.market.yandex.ru')return market.fetcher(u,o);
    remote.calls.push(url.pathname);
    if(url.pathname==='/v1/products')return Response.json([{id:8,stock:remote.stock,instant:true,price_usd:2}]);
    if(url.pathname==='/v1/me')return Response.json({balance:remote.balance,currency:'USD'});
    if(url.pathname==='/v1/buy')return Response.json({order:{id:'buy-1',status:remote.pending?'processing':'delivered',items:[{type:'text',content:'CDK-ONLY-123'}]}});
    throw new Error('Unexpected '+u);
  };
  return {env,store,market,category,input,remote,fetcher};
}
test('one SKU consumes manual account first then buys a CDK with its own instruction',async t=>{
  const x=await setup(t);await runAutomation(x.env,x.fetcher);
  let delivery=x.market.calls.find(c=>c.path.endsWith('/deliverDigitalGoods')).data.items[0];assert.match(delivery.codes[0],/manual@example.test/);assert.equal(delivery.slip,'Account instruction');assert.equal(x.remote.calls.length,0);
  const order=structuredClone(x.market.orders[0]);order.id=84729999;order.status='PROCESSING';x.market.orders.push(order);
  await runAutomation(x.env,x.fetcher);delivery=x.market.calls.filter(c=>c.path.endsWith('/deliverDigitalGoods')).at(-1).data.items[0];assert.deepEqual(delivery.codes,['CDK-ONLY-123']);assert.equal(delivery.slip,'Activate CDK here');assert.equal(x.remote.calls.filter(x=>x==='/v1/buy').length,1);
  assert.equal((await x.store.categories())[0].item_kind,'account');
});
test('supplier priority buys CDK while preserving available manual account',async t=>{
  const x=await setup(t,'supplier_first');await runAutomation(x.env,x.fetcher);
  assert.equal((await x.store.categories())[0].available,1);assert.equal(x.remote.calls.filter(x=>x==='/v1/buy').length,1);
  assert.deepEqual(x.market.calls.find(c=>c.path.endsWith('/deliverDigitalGoods')).data.items[0].codes,['CDK-ONLY-123']);
});
test('supplier priority falls back before checkout when stock or balance is insufficient',async t=>{
  for(const key of ['stock','balance'])await t.test(key,async t=>{const x=await setup(t,'supplier_first');x.remote[key]=0;await runAutomation(x.env,x.fetcher);assert.equal(x.remote.calls.filter(x=>x==='/v1/buy').length,0);assert.match(x.market.calls.find(c=>c.path.endsWith('/deliverDigitalGoods')).data.items[0].codes[0],/manual@example.test/);});
});
test('pending purchase never switches to manual stock after priority change',async t=>{
  const x=await setup(t,'supplier_first');x.remote.pending=true;await runAutomation(x.env,x.fetcher);assert.equal(x.market.calls.filter(c=>c.path.endsWith('/deliverDigitalGoods')).length,0);
  await x.store.saveCategory({...x.input,id:x.category.id,deliveryPriority:'pool_first'});x.remote.pending=false;await runAutomation(x.env,x.fetcher);
  assert.equal((await x.store.categories())[0].available,1);assert.deepEqual(x.market.calls.find(c=>c.path.endsWith('/deliverDigitalGoods')).data.items[0].codes,['CDK-ONLY-123']);
});
test('changing supplier format during pending purchase is rejected before another buy',async t=>{
  const x=await setup(t,'supplier_first');x.remote.pending=true;const c=await x.store.categoryByOffer(x.input.offerId);
  await assert.rejects(procure(x.store,x.env,{orderId:'123',itemId:1,category:c,quantity:1},x.fetcher),/выполняется/);
  const count=x.remote.calls.length;await assert.rejects(procure(x.store,x.env,{orderId:'123',itemId:1,category:{...c,supplier_kind:'account'},quantity:1},x.fetcher),/другим форматом/);assert.equal(x.remote.calls.length,count);
});
test('old editor saves preserve split format and priority; inventory history remains intact',async t=>{
  const x=await setup(t,'supplier_first');const {supplierKind,supplierSlip,deliveryPriority,...legacy}=x.input;await x.store.saveCategory({...legacy,id:x.category.id});const c=await x.store.categoryByOffer(x.input.offerId);assert.equal(c.supplier_kind,'code');assert.equal(c.supplier_slip,'Activate CDK here');assert.equal(c.delivery_priority,'supplier_first');assert.equal((await x.store.categories())[0].available,1);
  await assert.rejects(x.store.saveCategory({...x.input,id:x.category.id,kind:'code'}),/Тип категории нельзя/);
});
