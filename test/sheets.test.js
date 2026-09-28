import {test} from 'node:test';
import assert from 'node:assert/strict';
import {syncSheets} from '../src/sheets.js';
import {Inventory} from '../src/inventory.js';
import {localDB} from '../src/local-db.js';
test('Google sync uses service-account token, typed strings, atomic replacement and preserves archive',async()=>{
 const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const pem='-----BEGIN PRIVATE KEY-----\n'+Buffer.from(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).toString('base64')+'\n-----END PRIVATE KEY-----';
 const env={DB:localDB(),DATA_ENCRYPTION_KEY:Buffer.alloc(32,2).toString('base64'),GOOGLE_SHEET_ID:'test-sheet',GOOGLE_SERVICE_ACCOUNT_JSON:JSON.stringify({client_email:'test@example.invalid',private_key:pem})};
 const store=new Inventory(env),c=await store.saveCategory({name:'Test',offerId:'TEST',slip:'Use code',activateTill:'2030-01-01'});
 await store.saveItems({categoryId:c.id,items:[{kind:'code',code:'=IMPORTXML("https://example.invalid")'}]});
 const calls=[];const fetcher=async(url,opts)=>{calls.push({url,opts});if(url.includes('oauth2'))return Response.json({access_token:'test-token'});if(opts.method==='GET')return Response.json({sheets:[{properties:{sheetId:1,title:'Архив Excel',gridProperties:{rowCount:1000,columnCount:26}}},{properties:{sheetId:2,title:'Заказы — авто',gridProperties:{rowCount:1000,columnCount:26}}},{properties:{sheetId:3,title:'Пул — авто',gridProperties:{rowCount:1000,columnCount:26}}}]});return Response.json({});};
 await syncSheets(store,env,fetcher);
 const requests=JSON.parse(calls.at(-1).opts.body).requests;
 const writes=requests.filter(x=>x.updateCells).map(x=>x.updateCells);
 assert.deepEqual(writes.map(x=>x.range.sheetId),[2,3]);assert.equal(writes[1].rows[1].values[6].userEnteredValue.stringValue,'=IMPORTXML("https://example.invalid")');
 assert.ok(writes[1].rows[1].values[9].userEnteredValue.numberValue>40000);
 assert.equal(calls.at(-1).opts.headers.Authorization,'Bearer test-token');
 assert.ok(await store.q("SELECT * FROM jobs WHERE name='sheets_last_success'").first());env.DB.close();
});
test('Google sync supports Apps Script without service-account credentials',async()=>{
 const env={DB:localDB(),DATA_ENCRYPTION_KEY:Buffer.alloc(32,4).toString('base64'),GOOGLE_APPS_SCRIPT_URL:'https://script.google.com/macros/s/test/exec',SHEETS_SYNC_SECRET:'secret'};
 const store=new Inventory(env);let sent;
 const fetcher=async(url,options)=>{sent={url,body:JSON.parse(options.body),type:options.headers['Content-Type']};return Response.json({ok:true});};
 const result=await syncSheets(store,env,fetcher);
 assert.equal(result.ok,true);assert.equal(sent.body.secret,'secret');assert.equal(sent.body.orders[0][0],'№ заказа');assert.equal(sent.type,'text/plain;charset=utf-8');
 env.DB.close();
});
