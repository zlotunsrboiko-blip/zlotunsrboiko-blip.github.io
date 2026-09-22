import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import worker from '../src/worker.js';
const origin='https://zlotunsrboiko-blip.github.io';
const env={GITHUB_PAGES_ORIGIN:origin,YANDEX_BUSINESS_ID:'216918278',YANDEX_CAMPAIGN_ID:'149189839',APP_PASSWORD:'a-long-example-password'};
test('Pages entry is self-contained and has all three tabs',()=>{
 const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.ok(!/<script[^>]+src=/.test(html));assert.ok(!/<link[^>]+stylesheet/.test(html));
 for(const tab of ['orders','history','chats']) assert.ok(html.includes(`data-tab="${tab}"`));
 const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];assert.equal(scripts.length,2);
 scripts.forEach(script=>new vm.Script(script[1]));
 assert.ok(html.includes('Подключение к Маркету'));assert.ok(!html.includes('ACMA:'));
});
test('trusted Pages origin receives preflight and settings without credentials',async()=>{
 const pre=await worker.fetch(new Request('https://example.workers.dev/api/orders',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'x-market-key'}}),env);
 assert.equal(pre.status,204);assert.equal(pre.headers.get('Access-Control-Allow-Origin'),origin);assert.ok(pre.headers.get('Access-Control-Allow-Headers').includes('X-Market-Key'));
 const res=await worker.fetch(new Request('https://example.workers.dev/api/settings',{headers:{Origin:origin}}),env);
 assert.equal(res.status,200);assert.equal(res.headers.get('Access-Control-Allow-Origin'),origin);assert.equal((await res.json()).passwordRequired,true);
});
test('untrusted origins are rejected and allowed origin still needs credentials',async()=>{
 const forbidden=await worker.fetch(new Request('https://example.workers.dev/api/settings',{headers:{Origin:'https://attacker.example'}}),env);assert.equal(forbidden.status,403);assert.equal(forbidden.headers.get('Access-Control-Allow-Origin'),null);
 const noKey=await worker.fetch(new Request('https://example.workers.dev/api/config',{headers:{Origin:origin,'X-App-Request':'digital-goods'}}),env);assert.equal(noKey.status,401);assert.equal(noKey.headers.get('Access-Control-Allow-Origin'),origin);
});
