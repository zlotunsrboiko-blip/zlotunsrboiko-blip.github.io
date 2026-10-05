import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localDB} from '../src/local-db.js';
import {Inventory,unseal} from '../src/inventory.js';
import {runAutomation} from '../src/automation.js';
import {procure} from '../src/procurement.js';
import {makeMarketMock} from './fixtures.js';

const ROBOTIC_PRODUCT='rvn:12:monthly:usd';
const ORDER_ID='84729105';

function setup(t){
  const env={DB:localDB(),DATA_ENCRYPTION_KEY:Buffer.alloc(32,19).toString('base64'),YANDEX_API_KEY:'demo-key',YANDEX_BUSINESS_ID:'216918278',YANDEX_CAMPAIGN_ID:'149189839',APP_PASSWORD:'two-shops-test-password',REQUIRE_PASSWORD:'true',AUTO_DELIVERY:'true',MKE_API_KEY:'mke-test-only',ROBOTICVN_API_KEY:'robotic-test-only'};
  t.after(()=>env.DB.close());
  const store=new Inventory(env),market=makeMarketMock();
  market.orders.splice(1);
  const category=input=>store.saveCategory({name:'Test category',kind:'account',offerId:'DIGITAL-'+ORDER_ID,slip:'Use the supplied credentials.',activateTill:'2099-12-31',...input});
  const dispatch=supplier=>async(url,options={})=>{
    const host=new URL(url).hostname;
    if(host==='api.partner.market.yandex.ru')return market.fetcher(url,options);
    if(['api.roboticvn.com','api.technysoft.com'].includes(host))return supplier(new URL(url),options);
    throw new Error('Unexpected external host in test: '+host);
  };
  return {env,store,market,category,dispatch};
}

test('legacy supplier settings remain MKE and provider-specific product IDs remain isolated',async t=>{
  const {store,category}=setup(t);
  const legacy=await category({supplierEnabled:true,supplierProductId:12});
  await store.q('UPDATE jobs SET value=? WHERE name=?',JSON.stringify({enabled:true,productId:12}),'supplier:'+legacy.id).run();
  const old=await store.categoryByOffer('DIGITAL-'+ORDER_ID);
  assert.equal(old.supplier_provider,'mke');
  assert.equal(old.supplier_product_id,12);
  const robotic=await category({name:'Robotic',offerId:'ROBOTIC',supplierProvider:'roboticvn',supplierProductId:ROBOTIC_PRODUCT,supplierEnabled:true});
  const read=await store.categoryByOffer('ROBOTIC');
  assert.equal(read.id,robotic.id);
  assert.equal(read.supplier_provider,'roboticvn');
  assert.equal(read.supplier_product_id,ROBOTIC_PRODUCT);
  await assert.rejects(category({offerId:'BAD-MKE',supplierProvider:'mke',supplierProductId:ROBOTIC_PRODUCT,supplierEnabled:true}),/товар поставщика/);
  await assert.rejects(category({offerId:'BAD-ROBOTIC',supplierProvider:'roboticvn',supplierProductId:12,supplierEnabled:true}),/товар поставщика/);
  assert.equal((await store.categoryByOffer('DIGITAL-'+ORDER_ID)).supplier_product_id,12);
});

test('pool provider and reusable filters precede pagination; empty selections match nothing',async t=>{
  const {store,category}=setup(t);
  const robotic=await category({name:'Robotic',offerId:'ROBOTIC',supplierProvider:'roboticvn',supplierProductId:ROBOTIC_PRODUCT,supplierEnabled:true});
  const mke=await category({name:'MKE',offerId:'MKE',supplierProductId:12,supplierEnabled:true});
  const local=await category({name:'Local',offerId:'LOCAL'});
  const universal=await category({name:'Universal',offerId:'UNIVERSAL',kind:'code',reusable:true});
  const accounts=(prefix,count)=>Array.from({length:count},(_,i)=>({kind:'account',login:prefix+i,password:'fixture-password'}));
  await store.saveItems({categoryId:robotic.id,items:accounts('robotic-',100)});
  await store.saveItems({categoryId:robotic.id,items:accounts('robotic-last-',3)});
  await store.saveItems({categoryId:mke.id,items:accounts('mke-',4)});
  await store.saveItems({categoryId:local.id,items:accounts('local-',2)});
  await store.saveItems({categoryId:universal.id,items:[{kind:'code',code:'https://example.test/universal'}]});
  const list=params=>store.list(new URLSearchParams(params));
  const first=await list({providers:'roboticvn',modes:'unique'});
  assert.equal(first.total,103);
  assert.equal(first.items.length,100);
  assert.equal(first.nextOffset,100);
  assert.ok(first.items.every(i=>i.category_id===robotic.id));
  const last=await list({providers:'roboticvn',modes:'unique',offset:String(first.nextOffset)});
  assert.equal(last.total,103);
  assert.equal(last.items.length,3);
  assert.equal(last.nextOffset,null);
  assert.equal(new Set([...first.items,...last.items].map(i=>i.id)).size,103);
  assert.equal((await list({providers:'mke'})).total,4);
  assert.equal((await list({providers:'local',modes:'unique'})).total,2);
  const reusable=await list({providers:'local',modes:'reusable'});
  assert.equal(reusable.total,1);
  assert.equal(reusable.items[0].category_id,universal.id);
  assert.equal((await list({providers:'mke,roboticvn',modes:'unique'})).total,107);
  for(const params of [{providers:''},{modes:''},{providers:'roboticvn',modes:'reusable'},{providers:'mke',category:robotic.id}])assert.deepEqual(await list(params),{items:[],total:0,nextOffset:null});
  await assert.rejects(list({providers:'unknown'}),/фильтр/);
});

test('expired activation date blocks procurement before either shop can charge',async t=>{
  for(const provider of ['mke','roboticvn'])await t.test(provider,async t=>{
    const {env,store,category,dispatch,market}=setup(t);
    const saved=await category({supplierProvider:provider,supplierProductId:provider==='mke'?12:ROBOTIC_PRODUCT,supplierEnabled:true});
    await store.q('UPDATE categories SET activate_till=? WHERE id=?','2000-01-01',saved.id).run();
    let purchases=0;
    const result=await runAutomation(env,dispatch(async()=>{purchases++;throw new Error('A supplier must not be contacted for an expired category');}));
    assert.equal(result.delivered,0);
    assert.equal(result.failures,1);
    assert.equal(purchases,0);
    assert.equal(await store.prepared(ORDER_ID),null);
    assert.equal(market.calls.filter(c=>c.path.endsWith('/deliverDigitalGoods')).length,0);
    const journal=(await store.q('SELECT action FROM audit WHERE entity_id=?',ORDER_ID).all()).results;
    assert.ok(journal.some(row=>row.action.includes('Срок активации уже истёк')));
  });
});

test('existing MKE automatic purchase uses its key, stays idempotent and delivers once',async t=>{
  const {env,store,category,dispatch,market}=setup(t);
  await category({supplierProductId:12,supplierEnabled:true});
  let purchases=0;
  const fetcher=dispatch(async(url,options)=>{
    assert.equal(url.origin,'https://api.technysoft.com');
    assert.equal(url.pathname,'/v1/buy');
    assert.equal(options.headers['X-API-Key'],'mke-test-only');
    assert.equal(options.headers['Idempotency-Key'],'ym-'+ORDER_ID+'-1');
    assert.deepEqual(JSON.parse(options.body),{product_id:12,quantity:1});
    purchases++;
    return Response.json({order:{id:501,status:'delivered',items:[{type:'text',content:'mke-login|mke-password|mke-backup'}]}});
  });
  assert.equal((await runAutomation(env,fetcher)).delivered,1);
  await runAutomation(env,fetcher);
  assert.equal(purchases,1);
  assert.equal((await store.prepared(ORDER_ID)).state,'accepted');
  const sends=market.calls.filter(c=>c.path.endsWith('/deliverDigitalGoods'));
  assert.equal(sends.length,1);
  assert.match(sends[0].data.items[0].codes[0],/mke-login/);
  const raw=await store.q('SELECT value FROM jobs WHERE name=?','purchase:'+ORDER_ID+':1').first();
  assert.ok(!raw.value.includes('mke-password'));
  const purchase=JSON.parse(raw.value);
  assert.equal(purchase.provider,'mke');
  assert.equal((await unseal(await store.key(),purchase.result)).secrets[0].password,'mke-password');
});

const quote=()=>Response.json({data:{product_id:'12',variant_id:'monthly',quantity:1,currency_code:'usd',unit_price:2,total:2,available_quantity:5,can_purchase:true,realtime:true}});
const wallet=(usd=20)=>Response.json({data:{usd,vnd:500000}});
const roboticOrder=()=>Response.json({data:{id:'robotic-order-501',status:'processing',payment_status:'captured',total:2,currency_code:'usd',items:[{id:'robotic-line-1',product_id:'12',variant_id:'monthly',quantity:1}]}});

test('uncertain ROBOTICVN checkout never charges again on later automation runs or provider remapping',async t=>{
  const {env,store,category,dispatch,market}=setup(t);
  const saved=await category({supplierProvider:'roboticvn',supplierProductId:ROBOTIC_PRODUCT,supplierEnabled:true});
  let posts=0,quotes=0;
  const fetcher=dispatch(async(url,options)=>{
    assert.equal(url.origin,'https://api.roboticvn.com');
    assert.equal(options.headers['x-api-key'],'robotic-test-only');
    if(url.pathname==='/api/v2/wallet/balance')return wallet();
    if(url.pathname==='/api/v2/products/12/quote'){quotes++;return quote();}
    assert.equal(url.pathname,'/api/v2/orders');
    assert.equal(options.method,'POST');
    posts++;
    throw new Error('Timeout after upstream may have charged the wallet');
  });
  for(let i=0;i<3;i++){
    const result=await runAutomation(env,fetcher);
    assert.equal(result.delivered,0);
    assert.equal(result.failures,1);
  }
  assert.equal(posts,1);
  assert.equal(quotes,1);
  assert.equal(await store.prepared(ORDER_ID),null);
  assert.equal(market.calls.filter(c=>c.path.endsWith('/deliverDigitalGoods')).length,0);
  const attempt=JSON.parse((await store.q('SELECT value FROM jobs WHERE name=?','purchase:'+ORDER_ID+':1').first()).value);
  assert.equal(attempt.state,'uncertain');
  assert.equal(attempt.provider,'roboticvn');
  assert.equal(attempt.supplierOrderId,undefined);
  await category({id:saved.id,supplierProvider:'mke',supplierProductId:12,supplierEnabled:true});
  await assert.rejects(procure(store,env,{orderId:ORDER_ID,itemId:1,category:await store.categoryByOffer('DIGITAL-'+ORDER_ID),quantity:1},fetcher),{code:'purchase_mapping_changed'});
  assert.equal(posts,1);
});

test('mixed-shop order polls ROBOTICVN, retains MKE purchase and sends supplementary account data once',async t=>{
  const {env,store,category,dispatch,market}=setup(t);
  await category({supplierProductId:12,supplierEnabled:true});
  await category({name:'Robotic',offerId:'ROBOTIC-OFFER',supplierProvider:'roboticvn',supplierProductId:ROBOTIC_PRODUCT,supplierEnabled:true});
  market.orders[0].items.push({...market.orders[0].items[0],id:2,offerId:'ROBOTIC-OFFER'});
  const extra='2FA: ROBOTIC-BACKUP\nRecovery: https://example.invalid/recovery|with-details\nKeep this line';
  const robotCredential={item_id:'robotic-line-1',quantity:1,account:'robotic@example.invalid',password:'robotic-private-password',additional_info:extra};
  let ready=false,mkePurchases=0,roboticPurchases=0,roboticPolls=0;
  const fetcher=dispatch(async(url,options)=>{
    if(url.hostname==='api.technysoft.com'){
      assert.equal(options.headers['X-API-Key'],'mke-test-only');
      assert.equal(options.headers['Idempotency-Key'],'ym-'+ORDER_ID+'-1');
      mkePurchases++;
      return Response.json({order:{id:601,status:'delivered',items:[{type:'text',content:'mke@example.invalid|mke-private-password|mke-2fa'}]}});
    }
    assert.equal(options.headers['x-api-key'],'robotic-test-only');
    if(url.pathname==='/api/v2/wallet/balance')return wallet();
    if(url.pathname==='/api/v2/products/12/quote')return quote();
    if(url.pathname==='/api/v2/orders'){
      assert.equal(options.method,'POST');
      assert.deepEqual(JSON.parse(options.body),{items:[{variant_id:'monthly',quantity:1}],currency_code:'usd',payment_method:'wallet'});
      roboticPurchases++;
      return Response.json({data:{order_id:'robotic-order-501',status:'processing'}},{status:201});
    }
    if(url.pathname==='/api/v2/orders/robotic-order-501'){
      roboticPolls++;
      const row=await store.q('SELECT value FROM jobs WHERE name=?','purchase:'+ORDER_ID+':2').first();
      assert.equal(JSON.parse(row.value).supplierOrderId,'robotic-order-501','The supplier ID must be saved before polling');
      return roboticOrder();
    }
    assert.equal(url.pathname,'/api/v2/orders/robotic-order-501/delivery');
    const records=ready?[robotCredential]:[];
    return Response.json({delivered_accounts:records,deliveredAccount:records});
  });
  const first=await runAutomation(env,fetcher);
  assert.equal(first.delivered,0);
  assert.equal(first.failures,1);
  assert.equal(await store.prepared(ORDER_ID),null);
  assert.equal(market.calls.filter(c=>c.path.endsWith('/deliverDigitalGoods')).length,0);
  ready=true;
  const second=await runAutomation(env,fetcher);
  assert.equal(second.delivered,1);
  await runAutomation(env,fetcher);
  assert.equal(mkePurchases,1);
  assert.equal(roboticPurchases,1);
  assert.equal(roboticPolls,2);
  assert.equal((await store.prepared(ORDER_ID)).state,'accepted');
  const sends=market.calls.filter(c=>c.path.endsWith('/deliverDigitalGoods'));
  assert.equal(sends.length,1);
  assert.equal(sends[0].data.items.length,2);
  const code=sends[0].data.items.find(i=>i.id===2).codes[0];
  assert.ok(code.includes(robotCredential.account));
  assert.ok(code.includes(robotCredential.password));
  assert.ok(code.endsWith(extra),'All supplementary supplier data must reach the buyer unchanged');
  const rows=(await store.q("SELECT value FROM jobs WHERE name LIKE 'purchase:%'").all()).results;
  assert.equal(rows.length,2);
  for(const row of rows){
    assert.ok(!row.value.includes('@example.invalid'));
    assert.ok(!row.value.includes('private-password'));
    assert.ok(!row.value.includes('ROBOTIC-BACKUP'));
    const attempt=JSON.parse(row.value);
    assert.match(attempt.result,/^v1\./);
    if(attempt.provider==='roboticvn'){
      const decrypted=await unseal(await store.key(),attempt.result);
      assert.equal(decrypted.codes[0],code);
      assert.equal(decrypted.secrets[0].additionalInfo,extra);
    }
  }
  const units=(await store.q('SELECT secret FROM delivery_units WHERE order_id=?',ORDER_ID).all()).results;
  assert.ok(units.every(unit=>!unit.secret.includes('private-password')));
  const details=await store.orderSecrets(ORDER_ID);
  assert.equal(details.units.find(unit=>unit.item_id==='2').secret.additionalInfo,extra);
  const audit=JSON.stringify((await store.q('SELECT action FROM audit').all()).results);
  assert.ok(!audit.includes(robotCredential.password));
  assert.ok(!audit.includes('ROBOTIC-BACKUP'));
});

function roboticSuccess(url){
  if(url.pathname==='/api/v2/orders/robotic-order-501')return roboticOrder();
  assert.equal(url.pathname,'/api/v2/orders/robotic-order-501/delivery');
  return Response.json({delivered_accounts:[{item_id:'robotic-line-1',quantity:1,account:'fixture@example.invalid',password:'fixture-password',additional_info:'Fixture backup'}]});
}

test('empty ROBOTICVN wallet creates no purchase attempt and a later refill resumes automatically',async t=>{
  const {env,store,category,dispatch,market}=setup(t);
  await category({supplierProvider:'roboticvn',supplierProductId:ROBOTIC_PRODUCT,supplierEnabled:true});
  let usd=0,purchases=0;
  const fetcher=dispatch(async(url)=>{
    if(url.pathname==='/api/v2/products/12/quote')return quote();
    if(url.pathname==='/api/v2/wallet/balance')return wallet(usd);
    if(url.pathname==='/api/v2/orders'){
      purchases++;
      return Response.json({data:{order_id:'robotic-order-501',status:'processing'}},{status:201});
    }
    return roboticSuccess(url);
  });
  for(let i=0;i<2;i++){
    const result=await runAutomation(env,fetcher);
    assert.equal(result.delivered,0);
    assert.equal(result.failures,1);
    assert.equal(purchases,0);
    assert.equal(await store.q('SELECT value FROM jobs WHERE name=?','purchase:'+ORDER_ID+':1').first(),null);
  }
  usd=2;
  assert.equal((await runAutomation(env,fetcher)).delivered,1);
  assert.equal(purchases,1);
  assert.equal((await store.prepared(ORDER_ID)).state,'accepted');
  assert.equal(market.calls.filter(c=>c.path.endsWith('/deliverDigitalGoods')).length,1);
});

test('confirmed insufficient-balance checkout waits for backoff then safely retries the declined purchase',async t=>{
  const {env,store,category,dispatch,market}=setup(t);
  await category({supplierProvider:'roboticvn',supplierProductId:ROBOTIC_PRODUCT,supplierEnabled:true});
  let purchases=0;
  const fetcher=dispatch(async(url)=>{
    if(url.pathname==='/api/v2/products/12/quote')return quote();
    if(url.pathname==='/api/v2/wallet/balance')return wallet();
    if(url.pathname==='/api/v2/orders'){
      purchases++;
      if(purchases===1)return Response.json({error:{code:'insufficient_balance',message:'Sensitive upstream detail'}},{status:400});
      return Response.json({data:{order_id:'robotic-order-501',status:'processing'}},{status:201});
    }
    return roboticSuccess(url);
  });
  assert.equal((await runAutomation(env,fetcher)).delivered,0);
  const name='purchase:'+ORDER_ID+':1';
  const first=JSON.parse((await store.q('SELECT value FROM jobs WHERE name=?',name).first()).value);
  assert.equal(first.state,'failed');
  assert.equal(first.retryable,true);
  assert.ok(first.retryAfter>Date.now());
  assert.equal(first.supplierOrderId,undefined);
  assert.equal((await runAutomation(env,fetcher)).delivered,0);
  assert.equal(purchases,1,'The same declined checkout must not be hammered during backoff');
  await store.q('UPDATE jobs SET value=? WHERE name=?',JSON.stringify({...first,retryAfter:Date.now()-1000}),name).run();
  assert.equal((await runAutomation(env,fetcher)).delivered,1);
  assert.equal(purchases,2);
  assert.equal((await store.prepared(ORDER_ID)).state,'accepted');
  assert.equal(market.calls.filter(c=>c.path.endsWith('/deliverDigitalGoods')).length,1);
});

test('ROBOTICVN response for another variant is never delivered and does not trigger another purchase',async t=>{
  const {env,store,category,dispatch,market}=setup(t);
  await category({supplierProvider:'roboticvn',supplierProductId:ROBOTIC_PRODUCT,supplierEnabled:true});
  let purchases=0;
  const fetcher=dispatch(async(url)=>{
    if(url.pathname==='/api/v2/products/12/quote')return quote();
    if(url.pathname==='/api/v2/wallet/balance')return wallet();
    if(url.pathname==='/api/v2/orders'){
      purchases++;
      return Response.json({data:{order_id:'robotic-order-501',status:'completed'}},{status:201});
    }
    if(url.pathname==='/api/v2/orders/robotic-order-501'){
      const response=await roboticOrder().json();
      response.data.items[0].variant_id='different-variant';
      return Response.json(response);
    }
    return roboticSuccess(url);
  });
  for(let i=0;i<2;i++){
    const result=await runAutomation(env,fetcher);
    assert.equal(result.delivered,0);
    assert.equal(result.failures,1);
  }
  assert.equal(purchases,1);
  assert.equal(await store.prepared(ORDER_ID),null);
  assert.equal(market.calls.filter(c=>c.path.endsWith('/deliverDigitalGoods')).length,0);
  await assert.rejects(procure(store,env,{orderId:ORDER_ID,itemId:1,category:await store.categoryByOffer('DIGITAL-'+ORDER_ID),quantity:1},fetcher),{code:'supplier_order_mismatch'});
  assert.equal(purchases,1);
});
