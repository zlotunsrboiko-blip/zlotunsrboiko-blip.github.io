import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localDB} from '../src/local-db.js';
import {Inventory,seal,unseal,kopecks} from '../src/inventory.js';
import {handleApi} from '../src/api.js';
import {runAutomation} from '../src/automation.js';
import {sheetRows} from '../src/sheets.js';
import {makeMarketMock} from './fixtures.js';
async function setup(){
  const env={DB:localDB(),DATA_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),YANDEX_API_KEY:'demo-key',YANDEX_BUSINESS_ID:'216918278',YANDEX_CAMPAIGN_ID:'149189839',APP_PASSWORD:'a-long-example-password',REQUIRE_PASSWORD:'true',AUTO_DELIVERY:'true'};
  const store=new Inventory(env),mock=makeMarketMock();
  const category=await store.saveCategory({name:'Подписки',kind:'account',offerId:'DIGITAL-84729105',slip:'Инструкция',activateTill:'2030-12-31'});
  await store.saveItems({categoryId:category.id,items:[{kind:'account',login:'demo-login',password:'demo-password',twoFactor:'demo-backup'},{kind:'account',login:'demo-login-2',password:'demo-password-2'}]});
  async function api(path,input){const response=await handleApi(new Request('https://example.test'+path,{method:input===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-App-Request':'digital-goods','X-App-Password':env.APP_PASSWORD},body:input===undefined?undefined:JSON.stringify(input)}),env,mock.fetcher);return {status:response.status,data:await response.json()};}
  return {env,store,mock,category,api};
}
test('pool ciphertext, duplicate identities, revision conflict, blocked stock',async()=>{
  const {env,store,category}=await setup();
  await assert.rejects(store.saveItems({categoryId:category.id,items:[{kind:'code',code:'WRONG-TYPE'}]}),/только аккаунты/);
  const row=await store.q('SELECT * FROM inventory WHERE kind=?','account').first();
  assert.ok(!row.secret.includes('demo-login'));assert.ok(!row.secret.includes('demo-password'));
  const key=await store.key();assert.equal((await unseal(key,row.secret)).login,'demo-login');
  assert.notEqual(await seal(key,{a:1}),await seal(key,{a:1}));
  await assert.rejects(store.saveItems({categoryId:category.id,items:[{kind:'account',login:'demo-login',password:'changed'}]}),/уже есть/);
  const item=await store.reveal(row.id);
  await store.edit({...item.secret,id:row.id,version:1,status:'blocked'});
  await assert.rejects(store.edit({...item.secret,id:row.id,version:1,status:'available'}),/другом окне/);
  assert.equal((await store.categories())[0].available,1);env.DB.close();
});
test('prepare snapshots and reserves atomically; send only once and expose separate payout',async()=>{
  const {env,store,api,mock}=await setup(),orderId=84729105;
  assert.equal((await api('/api/pool/prepare',{orderId})).status,200);
  const reserved=await store.q("SELECT * FROM inventory WHERE status='reserved'").first();
  assert.ok(reserved);await assert.rejects(store.edit({id:reserved.id}),/нельзя перезаписать/);
  assert.equal((await api('/api/pool/prepare',{orderId})).status,409);
  assert.equal((await api('/api/deliver',{orderId})).status,200);
  assert.notEqual((await api('/api/deliver',{orderId})).status,200);
  assert.equal(mock.calls.filter(c=>c.path.endsWith('/deliverDigitalGoods')).length,1);
  assert.equal((await store.categories())[0].sold,1);
  const data=(await api('/api/ledger')).data.orders[0];assert.equal(data.payout_kopecks,null);assert.equal(data.amount_kopecks,149000);
  await store.payout({orderId,payout:'1200,45'});assert.equal((await store.ledger(new URLSearchParams())).orders[0].payout_kopecks,120045);
  await assert.rejects(store.release({orderId}),/Нельзя освободить/);env.DB.close();
});
test('explicit Yandex test order exercises the pool and delivery path',async()=>{
  const {env,store,api,mock}=await setup(),testOrder={...mock.orders[0],id:99900001,fake:true};mock.orders.push(testOrder);
  assert.equal((await api('/api/pool/prepare',{orderId:testOrder.id})).status,404);
  assert.equal((await api('/api/pool/prepare',{orderId:testOrder.id,test:true})).status,200);
  assert.equal((await api('/api/deliver',{orderId:testOrder.id})).status,200);
  assert.equal((await store.q('SELECT fake FROM orders WHERE id=?',String(testOrder.id)).first()).fake,1);
  assert.equal((await store.prepared(testOrder.id)).state,'accepted');env.DB.close();
});
test('unknown result remains reserved across later runs and is never resent',async()=>{
  const {env,store,mock}=await setup();let attempts=0;
  const fail=async(url,options)=>{if(String(url).endsWith('/deliverDigitalGoods')){attempts++;throw new Error('timeout');}return mock.fetcher(url,options);};
  await runAutomation(env,fail);await runAutomation(env,fail);
  assert.equal(attempts,1);assert.equal((await store.prepared('84729105')).state,'uncertain');
  assert.equal((await store.categories())[0].reserved,1);assert.equal((await store.categories())[0].available,1);env.DB.close();
});
test('short stock leaves no partial delivery or reservation',async()=>{
  const {env,store,mock}=await setup();mock.orders[0].items[0].count=3;
  await assert.rejects(store.prepare(mock.orders[0]),/недостаточно/);
  assert.equal(await store.prepared(84729105),null);assert.equal((await store.categories())[0].available,2);env.DB.close();
});
test('race while reserving rolls back all records and preserves competing reservation',async()=>{
  const {env,store,mock}=await setup();const batch=env.DB.batch.bind(env.DB);
  env.DB.batch=async statements=>{await store.q("UPDATE inventory SET status='blocked',version=version+1 WHERE id=(SELECT id FROM inventory ORDER BY created_at,id LIMIT 1)").run();return batch(statements);};
  await assert.rejects(store.prepare(mock.orders[0]),/Резерв изменился/);
  assert.equal(await store.prepared(84729105),null);assert.equal((await store.categories())[0].reserved,0);env.DB.close();
});
test('background processing fills ledger, is idempotent, and skips test/chat orders',async()=>{
  const {env,store,mock}=await setup();
  await runAutomation(env,mock.fetcher);await runAutomation(env,mock.fetcher);
  assert.equal(mock.calls.filter(c=>c.path.endsWith('/deliverDigitalGoods')).length,1);
  assert.equal((await store.ledger(new URLSearchParams())).total,4);
  assert.equal((await store.prepared(84729105)).state,'accepted');
  assert.equal((await store.ledger(new URLSearchParams({orderId:'84729105'}))).orders[0].status,'DELIVERED');
  const rows=await sheetRows(store);assert.ok(rows.orders[0].includes('Выплата после комиссий, ₽'));assert.equal(rows.pool.length,3);env.DB.close();
});
test('multiple lines with same offer select distinct accounts and sheet totals are not duplicated',async()=>{
  const {env,store,mock}=await setup(),o=mock.orders[0];o.items.push({...o.items[0],id:2});await store.prepare(o);
  const prepared=await store.prepared(o.id);assert.notEqual(prepared.payload.items[0].codes[0],prepared.payload.items[1].codes[0]);
  const rows=await sheetRows(store);assert.equal(rows.orders.length,3);assert.equal(rows.orders[1][9],1490);assert.equal(rows.orders[2][9],'');env.DB.close();
});
test('money distinguishes zero from missing and rejects malformed precision',()=>{
  assert.equal(kopecks(''),null);assert.equal(kopecks(0),0);assert.equal(kopecks('123.45'),12345);assert.throws(()=>kopecks('1.234'));assert.throws(()=>kopecks('-1'));
});
