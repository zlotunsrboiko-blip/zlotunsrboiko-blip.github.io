import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const origin='https://service.example',storageKey=`digital-goods-session:${origin}`;
const session={token:'b'.repeat(64),expiresAt:Date.now()+86400000};
const settings={businessId:'216918278',campaignId:'149189839',passwordRequired:true,rememberDeviceAvailable:true,serverKeyConfigured:true};
class Element{
  constructor(){this.value='';this.children=[];this.hidden=false;this.checked=false;this.disabled=false;this.dataset={};this.events=new Map();this.classList={toggle(){}};this.textContent='';}
  addEventListener(name,action){this.events.set(name,action);}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  insertAdjacentElement(){}
  setAttribute(){}
  removeAttribute(){}
  querySelector(){return null;}
  querySelectorAll(){return [];}
}
async function page({saved=session,failConfig,failLogout,storageDenied=false}={}){
  const nodes=new Map(),store=new Map(),calls=[];let reloads=0;
  if(saved)store.set(storageKey,JSON.stringify(saved));
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,new Element());return nodes.get(selector);};
  node('#workspace').hidden=true;node('#logout').hidden=true;node('#login-button').disabled=true;node('#remember-device').checked=true;
  const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  const context=vm.createContext({URL,URLSearchParams,Date,Intl,Map,Set,Response,console,
    fetch:async(input,options={})=>{
      const path=new URL(input).pathname;calls.push({path,options});
      if(path==='/api/settings')return reply(settings);
      if(path==='/api/config'){if(failConfig==='network')throw new Error('offline');if(failConfig===401)return reply({error:'Expired'},401);return reply({businessId:settings.businessId,campaignId:settings.campaignId});}
      if(path==='/api/orders')return reply({orders:[],nextPageToken:null});
      if(path==='/api/session')return reply(session);
      if(path==='/api/session/logout'){if(failLogout==='network')throw new Error('offline');if(failLogout===401)return reply({error:'Expired'},401);return reply({ok:true});}
      throw new Error(`Unexpected request: ${path}`);
    },
    localStorage:{getItem:key=>store.get(key)||null,removeItem:key=>store.delete(key),setItem(key,value){if(storageDenied)throw new Error('Storage disabled');store.set(key,value);}},
    location:{href:'https://pages.example/',reload(){reloads++;}},
    confirm:()=>true,setTimeout:()=>0,clearTimeout(){},
    document:{querySelector:selector=>selector.startsWith('#')&&!selector.includes(' ')?node(selector):null,querySelectorAll:()=>[],createElement:()=>new Element(),createTextNode:text=>text},
    window:{serviceUrl:path=>origin+path,connectionReady:Promise.resolve(),addEventListener(){}},
  });
  await vm.runInContext(source,context);
  return {calls,node,store,get reloads(){return reloads;},run:expression=>vm.runInContext(expression,context),dispatch:async(selector,event)=>node(selector).events.get(event)({preventDefault(){}})};
}

test('saved device restores the workspace with bearer auth and no password or API key',async()=>{
  const ui=await page();
  assert.equal(ui.node('#login').hidden,true);assert.equal(ui.node('#workspace').hidden,false);
  assert.equal(ui.run('state.credentials.token'),session.token);
  assert.equal(ui.run('state.credentials.password'),undefined);assert.equal(ui.run('state.credentials.key'),undefined);
  for(const call of ui.calls.filter(call=>call.path!=='/api/settings')){
    assert.equal(call.options.headers.Authorization,`Bearer ${session.token}`);
    assert.equal(call.options.headers['X-App-Password'],undefined);assert.equal(call.options.headers['X-Market-Key'],undefined);
  }
});

test('restore forgets rejected tokens while retaining tokens after a temporary network failure',async()=>{
  const rejected=await page({failConfig:401});
  assert.equal(rejected.store.has(storageKey),false);assert.equal(rejected.run('state.credentials'),null);
  assert.equal(rejected.node('#workspace').hidden,true);assert.match(rejected.node('#login-error').textContent,/Срок входа истёк/);
  const offline=await page({failConfig:'network'});
  assert.equal(offline.store.get(storageKey),JSON.stringify(session));assert.equal(offline.run('state.credentials'),null);
  assert.equal(offline.node('#login-button').disabled,false);assert.match(offline.node('#login-error').textContent,/обновив страницу/);
});

test('logout revokes then forgets the device, including an already-expired server session',async()=>{
  for(const failLogout of [undefined,401]){
    const ui=await page({failLogout});await ui.dispatch('#logout','click');
    const call=ui.calls.find(call=>call.path==='/api/session/logout');
    assert.equal(call.options.method,'POST');assert.equal(call.options.headers.Authorization,`Bearer ${session.token}`);
    assert.equal(ui.store.has(storageKey),false);assert.equal(ui.run('state.credentials'),null);assert.equal(ui.reloads,1);
  }
});

test('failed logout keeps remembered credentials and lets the user retry revocation',async()=>{
  const ui=await page({failLogout:'network'});await ui.dispatch('#logout','click');
  assert.equal(ui.store.get(storageKey),JSON.stringify(session));assert.equal(ui.run('state.credentials.token'),session.token);
  assert.equal(ui.reloads,0);assert.equal(ui.node('#logout').disabled,false);
  assert.match(ui.node('#notice').textContent,/Проверьте соединение/);
});

test('denied persistent storage still permits current-page login without retaining the password',async()=>{
  const ui=await page({saved:null,storageDenied:true});
  ui.node('#app-password').value='Test-long-password-123';
  ui.node('#api-key').value='Temporary-market-key';
  await ui.dispatch('#login-form','submit');
  assert.equal(ui.node('#workspace').hidden,false);assert.equal(ui.run('state.credentials.token'),session.token);
  assert.equal(ui.run('state.credentials.password'),undefined);assert.equal(ui.run('state.credentials.key'),undefined);
  assert.equal(ui.node('#app-password').value,'');assert.equal(ui.node('#api-key').value,'');
  assert.equal(ui.store.size,0);assert.match(ui.node('#toast').textContent,/браузер запретил запоминание/);
});
