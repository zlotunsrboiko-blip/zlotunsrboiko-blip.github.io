import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {handleApi} from '../src/api.js';
import {localDB} from '../src/local-db.js';
import worker from '../src/worker.js';
import {makeMarketMock} from './fixtures.js';

const password='Запомни-устройство-123456';
const baseEnv={YANDEX_BUSINESS_ID:'216918278',YANDEX_CAMPAIGN_ID:'149189839',YANDEX_API_KEY:'demo-key',APP_PASSWORD:password,REQUIRE_PASSWORD:'true'};
const freshPassword={'X-App-Password':encodeURIComponent(password)};
const bearer=token=>({Authorization:`Bearer ${token}`});
const tokenHash=token=>createHash('sha256').update(token).digest('hex');
function request(path,{headers={},method='GET'}={}){
  return new Request(`https://service.example${path}`,{method,headers:{'X-App-Request':'digital-goods','Content-Type':'application/json',...headers},...(method==='POST'?{body:'{}'}:{})});
}
function fixture(t){
  const db=localDB(),market=makeMarketMock(),env={...baseEnv,DB:db};
  t.after(()=>db.close());
  return {db,market,env,call:(path,options={},override=env)=>handleApi(request(path,options),override,market.fetcher)};
}
async function createSession(f){
  const response=await f.call('/api/session',{method:'POST',headers:freshPassword});
  assert.equal(response.status,200);
  return response.json();
}

test('remembered-device availability requires complete server-owned credentials and storage',async t=>{
  const f=fixture(t);
  assert.equal((await (await f.call('/api/settings')).json()).rememberDeviceAvailable,true);
  for(const [field,value] of [['DB',undefined],['APP_PASSWORD',undefined],['APP_PASSWORD','short'],['YANDEX_API_KEY',''],['YANDEX_BUSINESS_ID',''],['YANDEX_CAMPAIGN_ID','']]){
    const response=await f.call('/api/settings',{}, {...f.env,[field]:value});
    assert.equal(response.status,200);
    assert.equal((await response.json()).rememberDeviceAvailable,false,field);
  }
});

test('fresh login creates a 30-day opaque session while database holds no reusable secret',async t=>{
  const f=fixture(t),before=Date.now(),session=await createSession(f),after=Date.now();
  assert.match(session.token,/^[a-f0-9]{64}$/);
  assert.equal(typeof session.expiresAt,'number');
  assert.ok(session.expiresAt>=before+30*86400000&&session.expiresAt<=after+30*86400000);
  assert.equal(f.market.calls.filter(call=>call.path==='/v2/auth/token').length,1);
  const rows=(await f.db.prepare("SELECT name,value FROM jobs WHERE name LIKE 'session:%'").all()).results;
  assert.equal(rows.length,1);
  assert.equal(rows[0].name,`session:${tokenHash(session.token)}`);
  const stored=JSON.parse(rows[0].value);
  assert.equal(stored.expiresAt,session.expiresAt);
  assert.match(stored.authFingerprint,/^[a-f0-9]{64}$/);
  for(const secret of [session.token,password,encodeURIComponent(password),baseEnv.YANDEX_API_KEY])assert.ok(!JSON.stringify(rows).includes(secret));
  const response=await f.call('/api/orders',{headers:bearer(session.token)});
  assert.equal(response.status,200);
  assert.equal((await response.json()).orders.length,2);
});

test('wrong passwords and unmarked or foreign-origin requests cannot issue sessions',async t=>{
  const f=fixture(t);
  for(const headers of [{},{'X-App-Password':'wrong-password'}, {...freshPassword,'X-App-Request':''},{...freshPassword,Origin:'https://hostile.example'}]){
    const response=await f.call('/api/session',{method:'POST',headers});
    assert.ok([401,403].includes(response.status));
  }
  assert.equal(f.market.calls.length,0);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE name LIKE 'session:%'").first()).n,0);
});

test('a failed Market credential check never creates a remembered session',async t=>{
  const f=fixture(t);
  const response=await handleApi(request('/api/session',{method:'POST',headers:freshPassword}),f.env,async()=>new Response(JSON.stringify({status:'ERROR'}),{status:401}));
  assert.ok(response.status>=400);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE name LIKE 'session:%'").first()).n,0);
});

test('remembering a device cannot persist an API key or shop supplied only by the browser',async t=>{
  const f=fixture(t),headers={...freshPassword,'X-Market-Key':'demo-key','X-Business-Id':baseEnv.YANDEX_BUSINESS_ID,'X-Campaign-Id':baseEnv.YANDEX_CAMPAIGN_ID};
  for(const field of ['YANDEX_API_KEY','YANDEX_BUSINESS_ID','YANDEX_CAMPAIGN_ID']){
    const response=await f.call('/api/session',{method:'POST',headers},{...f.env,[field]:''});
    assert.equal(response.status,503,field);
  }
  assert.equal(f.market.calls.length,0);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE name LIKE 'session:%'").first()).n,0);
});

test('session alone cannot mint or renew another session',async t=>{
  const f=fixture(t),session=await createSession(f),calls=f.market.calls.length;
  const response=await f.call('/api/session',{method:'POST',headers:bearer(session.token)});
  assert.equal(response.status,401);
  assert.equal(f.market.calls.length,calls);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE name LIKE 'session:%'").first()).n,1);
});

test('invalid, malformed and expired remembered sessions are rejected before Market access',async t=>{
  const f=fixture(t),session=await createSession(f),name=`session:${tokenHash(session.token)}`;
  const stored=JSON.parse((await f.db.prepare('SELECT value FROM jobs WHERE name=?').bind(name).first()).value);
  stored.expiresAt=Date.now()-1;
  await f.db.prepare('UPDATE jobs SET value=? WHERE name=?').bind(JSON.stringify(stored),name).run();
  const calls=f.market.calls.length;
  for(const token of ['a'.repeat(64),'not-a-token',session.token])assert.equal((await f.call('/api/orders',{headers:bearer(token)})).status,401);
  assert.equal(f.market.calls.length,calls);
});

test('logout revokes only that device and the revoked token cannot authenticate',async t=>{
  const f=fixture(t),first=await createSession(f),second=await createSession(f);
  assert.notEqual(first.token,second.token);
  const response=await f.call('/api/session/logout',{method:'POST',headers:bearer(first.token)});
  assert.equal(response.status,200);
  assert.equal(await f.db.prepare('SELECT value FROM jobs WHERE name=?').bind(`session:${tokenHash(first.token)}`).first(),null);
  assert.equal((await f.call('/api/orders',{headers:bearer(first.token)})).status,401);
  assert.equal((await f.call('/api/orders',{headers:bearer(second.token)})).status,200);
});

test('password, Market API key and shop changes invalidate existing remembered devices',async t=>{
  const f=fixture(t);
  for(const [field,value] of [['APP_PASSWORD','Новый-пароль-123456789'],['YANDEX_API_KEY','new-market-key'],['YANDEX_BUSINESS_ID','999999'],['YANDEX_CAMPAIGN_ID','888888']]){
    const session=await createSession(f),calls=f.market.calls.length;
    const response=await f.call('/api/orders',{headers:bearer(session.token)},{...f.env,[field]:value});
    assert.equal(response.status,401,field);
    assert.equal(f.market.calls.length,calls,field);
  }
});

test('Pages CORS allows bearer authorization only for the exact configured origin',async()=>{
  const origin='https://zlotunsrboiko-blip.github.io',env={...baseEnv,GITHUB_PAGES_ORIGIN:origin};
  const response=await worker.fetch(new Request('https://service.example/api/orders',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization,x-app-request'}}),env);
  assert.equal(response.status,204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),origin);
  assert.match(response.headers.get('Access-Control-Allow-Headers'),/(^|,\s*)Authorization(\s*,|$)/i);
  for(const badOrigin of ['https://hostile.example',`${origin}.hostile.example`])assert.equal((await worker.fetch(new Request('https://service.example/api/orders',{method:'OPTIONS',headers:{Origin:badOrigin}}),env)).status,403);
});
