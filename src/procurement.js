import {SupplierError,supplierBuy,parseSupplierCredential} from './supplier.js';
import {roboticQuote,roboticAccount,roboticCreateOrder,roboticOrder} from './roboticvn.js';
import {seal,unseal,deliveryText} from './inventory.js';

// An attempt belongs to a Market order line, not to the current category mapping.
// Changing providers must never initiate a second purchase for the same line.
export async function procure(store,env,{orderId,itemId,category,quantity},fetcher=fetch){
  const name=`purchase:${orderId}:${itemId}`;
  const read=async()=>{const row=await store.q('SELECT value FROM jobs WHERE name=?',name).first();return row?JSON.parse(row.value):null;};
  const save=async value=>store.q('UPDATE jobs SET value=?,updated_at=? WHERE name=?',JSON.stringify(value),new Date().toISOString(),name).run();
  let attempt=await read();
  const provider=category.supplier_provider||'mke';
  if(attempt&&(attempt.provider!==provider||String(attempt.productId)!==String(category.supplier_product_id)||attempt.quantity!==quantity))throw new SupplierError('Для этой позиции уже есть закупка с другими настройками. Проверьте её в магазине поставщика.','purchase_mapping_changed',409);
  if(attempt?.result)return unseal(await store.key(),attempt.result);
  if(attempt?.state==='failed'&&attempt.retryable){
    if(Date.now()<attempt.retryAfter)throw new SupplierError('ROBOTICVN SHOP отклонил закупку без выдачи. Повторная проверка — через минуту.','supplier_retry_later',409);
    const cleared=await store.q('DELETE FROM jobs WHERE name=? AND value=?',name,JSON.stringify(attempt)).run();
    if(!cleared.meta.changes)throw new SupplierError('Закупка уже проверяется.','purchase_busy',409);
    attempt=null;
  }
  if(!attempt){
    if(provider==='roboticvn'){
      const quote=await roboticQuote(env,{productId:category.supplier_product_id,quantity},fetcher);
      const wallet=await roboticAccount(env,fetcher),balance=wallet.balances.find(x=>x.currency===quote.currency)?.balance;
      if(balance===undefined||balance<quote.total)throw new SupplierError(`Недостаточно средств в кошельке ROBOTICVN SHOP (${quote.currency}). Пополните баланс; проверка повторится автоматически.`,'insufficient_balance',409);
    }
    const initial={provider,productId:category.supplier_product_id,quantity,state:'starting',startedAt:new Date().toISOString()};
    const claim=await store.q('INSERT OR IGNORE INTO jobs(name,value,updated_at) VALUES(?,?,?)',name,JSON.stringify(initial),initial.startedAt).run();
    if(!claim.meta.changes)throw new SupplierError('Закупка уже выполняется. Дождитесь следующей проверки.','purchase_busy',409);
    attempt=initial;
    if(provider==='roboticvn'){
      // Persist starting BEFORE checkout. If the process dies, never POST again.
      try{
        const created=await roboticCreateOrder(env,{productId:attempt.productId,quantity},fetcher);
        attempt={...attempt,state:'processing',supplierOrderId:created.supplierOrderId};
        await save(attempt);
        await store.audit(String(orderId),`supplier_order:provider=roboticvn,order=${created.supplierOrderId}`);
      }catch(error){
        const retryable=!error.uncertain&&(['insufficient_balance','insufficient_funds','out_of_stock','product_unavailable','invalid_key','invalid_api_key','rate_limited'].includes(error.code)||[401,403,429].includes(error.status));
        if(!attempt.supplierOrderId)await save({...attempt,state:error.uncertain?'uncertain':'failed',errorCode:error.code||'purchase_error',retryable,retryAfter:Date.now()+60000});
        throw error;
      }
    }
  }
  let result;
  if(provider==='mke'){
    const bought=await supplierBuy(env,{productId:attempt.productId,quantity,idempotencyKey:`ym-${orderId}-${itemId}`},fetcher);
    const secrets=bought.texts.map(value=>parseSupplierCredential(category.item_kind,value));
    result={...bought,secrets,codes:secrets.map(deliveryText),provider};
  }else{
    if(!attempt.supplierOrderId)throw new SupplierError('ROBOTICVN SHOP: результат закупки требует проверки в магазине. Повторная покупка остановлена, чтобы не списать деньги дважды.','purchase_uncertain',409);
    const bought=await roboticOrder(env,attempt.supplierOrderId,fetcher);
    const [,encodedProduct,encodedVariant,currency]=String(attempt.productId).split(':');
    if(bought.items?.length!==1||bought.items[0].variantId!==decodeURIComponent(encodedVariant)||(bought.items[0].productId&&bought.items[0].productId!==decodeURIComponent(encodedProduct))||bought.quantity!==quantity||bought.currency!==currency.toUpperCase())throw new SupplierError('ROBOTICVN SHOP: состав закупки отличается от выбранного товара. Автовыдача остановлена для проверки.','supplier_order_mismatch',409);
    if(bought.status!=='delivered')throw new SupplierError('ROBOTICVN SHOP: заказ оплачен, ожидаем данные товара. Проверка повторится автоматически.','supplier_processing',409);
    if(bought.texts?.length!==quantity)throw new SupplierError('ROBOTICVN SHOP: количество выданных данных не совпадает с заказом. Повторная покупка остановлена.','supplier_items',409);
    const secrets=category.item_kind==='code'?bought.texts.map(code=>({kind:'code',code,note:'ROBOTICVN SHOP'})):bought.credentials;
    if(category.item_kind==='account'&&(!secrets||secrets.some(c=>!c.login||!c.password)))throw new SupplierError('ROBOTICVN SHOP: формат данных не соответствует категории «Аккаунт». Проверьте заказ поставщика.','supplier_format',409);
    result={...bought,secrets,codes:bought.texts,provider};
  }
  await save({...attempt,state:'delivered',supplierOrderId:result.supplierOrderId,result:await seal(await store.key(),result)});
  await store.audit(String(orderId),`supplier_purchased:provider=${provider},order=${result.supplierOrderId},qty=${quantity}`);
  return result;
}
