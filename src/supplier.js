const ROOT='https://api.technysoft.com';
export class SupplierError extends Error{constructor(message,code='supplier_error',status=502){super(message);this.code=code;this.status=status;}}
async function request(env,path,options={},fetcher=fetch){
  if(!env.MKE_API_KEY)throw new SupplierError('Ключ MKE SHOP не настроен.','supplier_not_configured',503);
  let response;
  try{response=await fetcher(ROOT+path,{...options,headers:{'X-API-Key':env.MKE_API_KEY,'Content-Type':'application/json',...(options.headers||{})},signal:AbortSignal.timeout(25000)});}catch{throw new SupplierError('MKE SHOP временно недоступен.','supplier_unavailable');}
  let data={};try{data=await response.json();}catch{}
  if(!response.ok){const code=data.error?.code||'supplier_error',known={insufficient_balance:'Недостаточно средств на балансе MKE SHOP.',out_of_stock:'У поставщика закончился товар.',product_unavailable:'Товар MKE SHOP сейчас недоступен.',invalid_key:'Ключ MKE SHOP недействителен.',rate_limited:'MKE SHOP ограничил частоту запросов.',idempotency_conflict:'Закупка уже выполняется; проверка повторится через минуту.'};throw new SupplierError(known[code]||data.error?.message_en||'MKE SHOP отклонил запрос.',code,response.status);}
  return data;
}
export const supplierAccount=(env,fetcher)=>request(env,'/v1/me',{},fetcher);
export const supplierProducts=(env,fetcher)=>request(env,'/v1/products',{},fetcher);
export async function supplierBuy(env,{productId,quantity,idempotencyKey},fetcher=fetch){
  const data=await request(env,'/v1/buy',{method:'POST',headers:{'Idempotency-Key':idempotencyKey},body:JSON.stringify({product_id:Number(productId),quantity:Number(quantity)})},fetcher);
  const order=data.order||{};
  if(order.status==='processing')throw new SupplierError('Закупка принята и ещё выполняется; проверка повторится через минуту.','supplier_processing',409);
  if(order.status==='refunded')throw new SupplierError('Поставщик отменил закупку и вернул средства.','supplier_refunded',409);
  if(order.status!=='delivered')throw new SupplierError(`Неожиданный статус закупки: ${order.status||'не указан'}.`,'supplier_status',409);
  const texts=(order.items||[]).filter(x=>x.type==='text'&&typeof x.content==='string').map(x=>x.content.trim()).filter(Boolean);
  if(texts.length!==Number(quantity))throw new SupplierError('Поставщик не вернул нужное количество текстовых данных. Проверьте заказ в боте.','supplier_items',409);
  return {supplierOrderId:String(order.id),texts,activationUrl:order.activation_url||null,idempotentReplay:data.idempotent_replay===true};
}
export function parseSupplierCredential(kind,value){
  if(kind==='code')return {kind:'code',code:value,login:'',password:'',twoFactor:'',note:'MKE SHOP'};
  const parts=value.split(/\s*\|\s*|\t|\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(parts.length<2)throw new SupplierError('Формат аккаунта поставщика не содержит логин и пароль.','supplier_format',409);
  return {kind:'account',login:parts[0],password:parts[1],twoFactor:parts.slice(2).join(' | '),code:'',note:'MKE SHOP'};
}
