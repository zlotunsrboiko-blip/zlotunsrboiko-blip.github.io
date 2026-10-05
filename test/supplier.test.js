import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSupplierCredential,supplierBuy,SupplierError} from '../src/supplier.js';
test('supplier purchase uses idempotency and returns only delivered text items',async()=>{
  let sent;
  const fetcher=async(url,options)=>{sent={url,options};return Response.json({order:{id:7,status:'delivered',items:[{type:'text',content:'A|B|C'}]},idempotent_replay:false});};
  const result=await supplierBuy({MKE_API_KEY:'key'},{productId:12,quantity:1,idempotencyKey:'ym-1-2'},fetcher);
  assert.equal(sent.options.headers['Idempotency-Key'],'ym-1-2');assert.equal(JSON.parse(sent.options.body).product_id,12);assert.deepEqual(result.texts,['A|B|C']);
  assert.deepEqual(parseSupplierCredential('account',result.texts[0]),{kind:'account',login:'A',password:'B',twoFactor:'C',code:'',note:'MKE SHOP'});
});
test('supplier processing is retryable without exposing response details',async()=>{
  await assert.rejects(supplierBuy({MKE_API_KEY:'key'},{productId:1,quantity:1,idempotencyKey:'same'},async()=>Response.json({order:{id:1,status:'processing'}})),e=>e instanceof SupplierError&&e.code==='supplier_processing');
});
