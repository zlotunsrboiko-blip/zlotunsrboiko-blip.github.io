// Credentials are encrypted before persistence. Audit records never contain secrets.
export class StoreError extends Error {
  constructor(message, status=400) { super(message); this.status=status; }
}
const now=()=>new Date().toISOString();
const uid=()=>crypto.randomUUID();
const b64=bytes=>btoa(String.fromCharCode(...bytes));
const bytes=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
const enc=new TextEncoder(), dec=new TextDecoder();
export async function cipherKey(env) {
  let raw;
  try { raw=bytes(env.DATA_ENCRYPTION_KEY||''); } catch {}
  if(raw?.length!==32) throw new StoreError('Задайте DATA_ENCRYPTION_KEY: 32 случайных байта в Base64 в секретах Cloudflare.',503);
  return crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
export async function seal(key,value) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,enc.encode(JSON.stringify(value)));
  return `v1.${b64(iv)}.${b64(new Uint8Array(data))}`;
}
export async function unseal(key,value) {
  const [version,iv,data]=value.split('.');
  if(version!=='v1') throw new Error('Unsupported cipher');
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(iv)},key,bytes(data))));
}
function text(value,label,max=10000,required=false) {
  if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw new StoreError(`Проверьте поле «${label}».`);
  return value.trim();
}
export function credential(input) {
  const kind=input?.kind;
  if(!['account','code'].includes(kind))throw new StoreError('Выберите аккаунт или код.');
  return {kind,login:text(input.login||'','Логин',1000,kind==='account'),code:text(input.code||'','CDK',10000,kind==='code'),password:text(input.password||'','Пароль',1000,kind==='account'),twoFactor:text(input.twoFactor||'','2FA',3000),note:text(input.note||'','Примечание',3000)};
}
export function deliveryText(c) {
  if(c.kind==='code')return c.code;
  return [`Логин: ${c.login}`,`Пароль: ${c.password}`,c.twoFactor?`2FA: ${c.twoFactor}`:''].filter(Boolean).join('\n');
}
export function kopecks(value) {
  if(value===null||value===undefined||value==='')return null;
  if(!/^\d+(?:[.,]\d{1,2})?$/.test(String(value)))throw new StoreError('Сумма должна быть неотрицательной, с точностью до копеек.');
  const result=Math.round(Number(String(value).replace(',','.'))*100);
  if(!Number.isSafeInteger(result))throw new StoreError('Сумма слишком велика.');
  return result;
}
export class Inventory {
  constructor(env) {if(!env.DB)throw new StoreError('Онлайн-хранилище ещё не подключено. Создайте D1 и примените миграцию из инструкции.',503);this.db=env.DB;this.env=env;}
  q(sql,...args){return this.db.prepare(sql).bind(...args);}
  async key(){return this._key ||= await cipherKey(this.env);}
  async audit(id,action){return this.q('INSERT INTO audit(entity_id,action,created_at) VALUES(?,?,?)',id,action,now()).run();}
  async categories(){return (await this.q(`SELECT c.*, SUM(CASE WHEN i.status='available' THEN 1 ELSE 0 END) AS available,
    SUM(CASE WHEN i.status='reserved' THEN 1 ELSE 0 END) AS reserved,
    SUM(CASE WHEN i.status='sold' THEN 1 ELSE 0 END) AS sold,
    SUM(CASE WHEN i.status='blocked' THEN 1 ELSE 0 END) AS blocked
    FROM categories c LEFT JOIN inventory i ON i.category_id=c.id GROUP BY c.id ORDER BY c.name`).all()).results;}
  async saveCategory(input){
    const id=input.id||uid(),name=text(input.name,'Категория',150,true),offer=text(input.offerId,'Артикул Маркета',300,true),slip=text(input.slip,'Инструкция',10000,true),until=text(input.activateTill,'Срок активации',10,true),kind=input.kind||'account';
    if(!['account','code'].includes(kind))throw new StoreError('Выберите тип товара: аккаунт или CDK.');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(until)||!Number.isFinite(Date.parse(until))||new Date(until).toISOString().slice(0,10)!==until)throw new StoreError('Проверьте срок активации.');
    const t=now();
    const exists=await this.q('SELECT id FROM categories WHERE offer_id=? AND id<>?',offer,id).first();
    if(exists)throw new StoreError('Этот артикул уже связан с другой категорией.',409);
    if(input.id){if(!(await this.q('SELECT id FROM categories WHERE id=?',id).first()))throw new StoreError('Категория не найдена.',404);if(await this.q('SELECT id FROM inventory WHERE category_id=? AND kind<>? LIMIT 1',id,kind).first())throw new StoreError('Тип категории нельзя изменить, пока в ней есть товары другого типа.',409);}
    await this.db.batch([this.q('INSERT INTO categories(id,name,offer_id,item_kind,slip,activate_till,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,offer_id=excluded.offer_id,item_kind=excluded.item_kind,slip=excluded.slip,activate_till=excluded.activate_till,updated_at=excluded.updated_at',id,name,offer,kind,slip,until,t,t),this.q('INSERT INTO audit(entity_id,action,created_at) VALUES(?,?,?)',id,'category_saved',t)]);
    return {id};
  }
  async fingerprint(c){
    const key=await crypto.subtle.importKey('raw',bytes(this.env.DATA_ENCRYPTION_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    return b64(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(c.kind+':'+(c.kind==='code'?c.code:c.login)))));
  }
  async saveItems(input){
    const category=await this.q('SELECT id,item_kind FROM categories WHERE id=?',input.categoryId).first();if(!category)throw new StoreError('Выберите существующую категорию.');
    const items=input.items;
    if(!Array.isArray(items)||items.length<1||items.length>100)throw new StoreError('За раз можно добавить от 1 до 100 товаров.');
    const key=await this.key(),statements=[],t=now(),seen=new Set(),records=[];
    for(const value of items){
      const c=credential(value);if(c.kind!==category.item_kind)throw new StoreError(`Эта категория принимает только ${category.item_kind==='account'?'аккаунты':'CDK-коды'}. Создайте отдельную категорию для другого типа.`,409);const fingerprint=await this.fingerprint(c);
      if(seen.has(fingerprint))throw new StoreError('Такой логин или код повторяется в загрузке. Ничего не добавлено.',409);
      seen.add(fingerprint);const id=uid();
      records.push([id,input.categoryId,c.kind,await seal(key,c),fingerprint,t,t]);
    }
    if(await this.q(`SELECT id FROM inventory WHERE fingerprint IN (${[...seen].map(()=>'?').join(',')}) LIMIT 1`,...seen).first())throw new StoreError('Такой логин или код уже есть в пуле. Ничего не добавлено.',409);
    for(let i=0;i<records.length;i+=14){const group=records.slice(i,i+14);statements.push(this.q('INSERT INTO inventory(id,category_id,kind,secret,fingerprint,created_at,updated_at) VALUES '+group.map(()=>'(?,?,?,?,?,?,?)').join(','),...group.flat()));}
    statements.push(this.q('INSERT INTO audit(entity_id,action,created_at) VALUES(?,?,?)',input.categoryId,`inventory_added:${items.length}`,t));
    try{await this.db.batch(statements);}catch{throw new StoreError('Не удалось добавить товары. Возможен дубликат при параллельном добавлении; обновите пул.',409);}
    return {added:items.length};
  }
  async list(params){
    const category=params.get('category')||'',status=params.get('status')||'',offset=Number(params.get('offset')||0);
    if(!Number.isSafeInteger(offset)||offset<0)throw new StoreError('Некорректная страница.');
    const where='WHERE (?=\'\' OR i.category_id=?) AND (?=\'\' OR i.status=?)';
    const rows=(await this.q(`SELECT i.id,i.category_id,c.name AS category,i.kind,i.status,i.order_id,i.created_at,i.updated_at,i.version FROM inventory i JOIN categories c ON c.id=i.category_id ${where} ORDER BY i.created_at DESC,i.id LIMIT 100 OFFSET ?`,category,category,status,status,offset).all()).results;
    const count=await this.q(`SELECT COUNT(*) AS total FROM inventory i ${where}`,category,category,status,status).first();
    return {items:rows,total:count.total,nextOffset:offset+rows.length<count.total?offset+rows.length:null};
  }
  async reveal(id){
    const row=await this.q('SELECT * FROM inventory WHERE id=?',id).first();
    if(!row)throw new StoreError('Товар не найден.',404);
    await this.audit(id,'secret_viewed');
    return {...row,secret:await unseal(await this.key(),row.secret),fingerprint:undefined};
  }
  async edit(input){
    const row=await this.q('SELECT * FROM inventory WHERE id=?',input.id).first();
    if(!row)throw new StoreError('Товар не найден.',404);
    if(!['available','blocked'].includes(row.status))throw new StoreError('Выданный или зарезервированный товар нельзя перезаписать. История выдачи сохранена.',409);
    if(!['available','blocked'].includes(input.status))throw new StoreError('Доступны статусы «Доступен» и «Заблокирован».');
    const c=credential(input),category=await this.q('SELECT item_kind FROM categories WHERE id=?',row.category_id).first();
    if(!category||c.kind!==category.item_kind)throw new StoreError(`Эта категория принимает только ${category?.item_kind==='code'?'CDK-коды':'аккаунты'}.`,409);
    const key=await this.key(),fp=await this.fingerprint(c);
    if(await this.q('SELECT id FROM inventory WHERE fingerprint=? AND id<>?',fp,row.id).first())throw new StoreError('Такой логин или код уже есть.',409);
    const result=await this.q("UPDATE inventory SET kind=?,secret=?,fingerprint=?,status=?,updated_at=?,version=version+1 WHERE id=? AND version=? AND status IN ('available','blocked')",c.kind,await seal(key,c),fp,input.status,now(),row.id,input.version).run();
    if(!result.meta.changes)throw new StoreError('Запись изменилась в другом окне. Обновите пул.',409);
    await this.audit(row.id,'inventory_edited');return {ok:true};
  }
  async remove(input){
    const row=await this.q('SELECT status,version FROM inventory WHERE id=?',input.id).first();
    if(!row)throw new StoreError('Товар не найден.',404);
    if(!['available','blocked'].includes(row.status))throw new StoreError('Зарезервированный или выданный товар удалить нельзя: он связан с историей заказа.',409);
    const result=await this.q("DELETE FROM inventory WHERE id=? AND version=? AND status IN ('available','blocked')",input.id,input.version).run();
    if(!result.meta.changes)throw new StoreError('Запись изменилась в другом окне. Обновите пул.',409);
    await this.audit(input.id,'inventory_deleted');return {ok:true};
  }
  async recordOrders(orders){
    const values=[];
    for(const o of orders){
      if(o.delivery?.type!=='DIGITAL')continue;
      const payment=o.prices?.payment,currency=payment?.currencyId||null;
      values.push([String(o.id??o.orderId),o.creationDate||o.createdAt||null,o.status,o.fake?1:0,['RUB','RUR'].includes(currency)?kopecks(payment.value):null,currency,now()]);
    }
    for(let i=0;i<values.length;i+=14){const chunk=values.slice(i,i+14);await this.q('INSERT INTO orders(id,created_at,status,fake,amount_kopecks,currency,updated_at) VALUES '+chunk.map(()=>'(?,?,?,?,?,?,?)').join(',')+' ON CONFLICT(id) DO UPDATE SET status=excluded.status,amount_kopecks=COALESCE(excluded.amount_kopecks,orders.amount_kopecks),currency=COALESCE(excluded.currency,orders.currency),updated_at=excluded.updated_at',...chunk.flat()).run();}
  }
  async ledger(params){
    const offset=Number(params.get('offset')||0),search=params.get('orderId')||'';
    if(!Number.isSafeInteger(offset)||offset<0)throw new StoreError('Некорректная страница.');
    const rows=(await this.q(`SELECT o.*,d.state AS delivery_state,(SELECT COUNT(*) FROM delivery_units u WHERE u.order_id=o.id) AS units FROM orders o LEFT JOIN deliveries d ON d.order_id=o.id WHERE (?='' OR o.id=?) ORDER BY o.created_at DESC,o.id LIMIT 100 OFFSET ?`,search,search,offset).all()).results;
    const count=await this.q("SELECT COUNT(*) AS total FROM orders WHERE (?='' OR id=?)",search,search).first();
    return {orders:rows,total:count.total,nextOffset:offset+rows.length<count.total?offset+rows.length:null};
  }
  async orderSecrets(id){
    const units=(await this.q('SELECT * FROM delivery_units WHERE order_id=? ORDER BY item_id,unit_index',id).all()).results,key=await this.key();
    const delivery=await this.prepared(id);
    await this.audit(id,'order_secrets_viewed');
    return {units:await Promise.all(units.map(async u=>({...u,secret:await unseal(key,u.secret)}))),instructions:(delivery?.payload?.items||[]).map(item=>({itemId:String(item.id),slip:item.slip||'',activateTill:item.activate_till||''}))};
  }
  async payout(input){
    const result=await this.q('UPDATE orders SET payout_kopecks=?,updated_at=? WHERE id=?',kopecks(input.payout),now(),String(input.orderId)).run();
    if(!result.meta.changes)throw new StoreError('Заказ не найден.',404);
    await this.audit(String(input.orderId),'payout_updated');return {ok:true};
  }
  async prepared(id){
    const row=await this.q('SELECT * FROM deliveries WHERE order_id=?',String(id)).first();
    return row?{...row,payload:await unseal(await this.key(),row.payload)}:null;
  }
  async prepare(order,manualItems=null,allowFake=false){
    const orderId=String(order.id??order.orderId);
    if(await this.prepared(orderId))throw new StoreError('Выдача уже подготовлена. Откройте её в учёте заказов.',409);
    await this.recordOrders([order]);
    if(order.fake&&!allowFake)throw new StoreError('Тестовый заказ требует явного запуска из раздела «Тестовые заказы».');
    const key=await this.key(),t=now(),items=[],units=[],selected=[];
    for(const item of order.items||[]){
      const count=Number(item.count??item.quantity);
      if(!Number.isInteger(count)||count<1||count>100)throw new StoreError('Для выдачи через пул допустимо до 100 единиц в позиции.');
      if(manualItems){
        const manual=manualItems.find(x=>x.id===item.id);items.push(manual);
        for(let i=0;i<manual.codes.length;i++)units.push({itemId:String(item.id),index:i,inventoryId:null,secret:await seal(key,{kind:'manual',code:manual.codes[i]})});
      }else{
        const category=await this.q('SELECT * FROM categories WHERE offer_id=?',item.offerId||'').first();
        if(!category)throw new StoreError(`Нет категории для артикула ${item.offerId||item.id}.`);
        const rows=(await this.q("SELECT * FROM inventory WHERE category_id=? AND kind=? AND status='available' ORDER BY created_at,id LIMIT ?",category.id,category.item_kind,count+selected.length).all()).results.filter(r=>!selected.some(s=>s.id===r.id)).slice(0,count);
        if(rows.length!==count)throw new StoreError(`В категории «${category.name}» недостаточно доступных товаров.`,409);
        const codes=[];
        for(let i=0;i<rows.length;i++){
          const row=rows[i],c=await unseal(key,row.secret);codes.push(deliveryText(c));selected.push({...row,itemId:String(item.id)});
          units.push({itemId:String(item.id),index:i,inventoryId:row.id,secret:row.secret});
        }
        items.push({id:item.id,codes,slip:category.slip,activate_till:category.activate_till});
      }
    }
    if(!items.length||units.length>100)throw new StoreError('В заказе должно быть от 1 до 100 единиц товара.');
    const statements=[this.q('INSERT INTO deliveries VALUES(?,?,?,?,?)',orderId,'prepared',await seal(key,{orderId,items}),t,t)];
    for(const row of selected){
      // NULL violates NOT NULL if a concurrent request reserved/edited the item. D1 rolls back the ENTIRE batch.
      statements.push(this.q("UPDATE inventory SET status=CASE WHEN status='available' AND version=? THEN 'reserved' ELSE NULL END,order_id=?,item_id=?,updated_at=?,version=version+1 WHERE id=?",row.version,orderId,row.itemId,t,row.id));
    }
    for(const u of units)statements.push(this.q('INSERT INTO delivery_units VALUES(?,?,?,?,?)',orderId,u.itemId,u.index,u.inventoryId,u.secret));
    statements.push(this.q('INSERT INTO audit(entity_id,action,created_at) VALUES(?,?,?)',orderId,'delivery_prepared',t));
    try{await this.db.batch(statements);}catch{throw new StoreError('Резерв изменился в другом окне. Обновите заказ; повторной выдачи не было.',409);}
    return {orderId,items};
  }
  async claim(id){
    const r=await this.q("UPDATE deliveries SET state='sending',updated_at=? WHERE order_id=? AND state IN ('prepared','rejected')",now(),String(id)).run();
    if(!r.meta.changes)throw new StoreError('Повторная отправка заблокирована. Проверьте состояние выдачи.',409);
  }
  async outcome(id,state){
    const t=now(),statements=[this.q('UPDATE deliveries SET state=?,updated_at=? WHERE order_id=?',state,t,String(id))];
    if(state==='accepted')statements.push(this.q("UPDATE inventory SET status='sold',updated_at=?,version=version+1 WHERE order_id=? AND status='reserved'",t,String(id)));
    statements.push(this.q('INSERT INTO audit(entity_id,action,created_at) VALUES(?,?,?)',String(id),`delivery_${state}`,t));
    await this.db.batch(statements);
  }
  async release(input){
    // Only definitely unsent/rejected reservations may return to the pool.
    const id=String(input.orderId),row=await this.prepared(id);
    if(!row||!['prepared','rejected'].includes(row.state))throw new StoreError('Нельзя освободить отправленный товар или выдачу с неизвестным результатом.',409);
    const t=now();
    await this.db.batch([
      this.q("UPDATE deliveries SET state=CASE WHEN state IN ('prepared','rejected') THEN 'prepared' ELSE NULL END WHERE order_id=?",id),
      this.q("UPDATE inventory SET status='available',order_id=NULL,item_id=NULL,updated_at=?,version=version+1 WHERE order_id=? AND status='reserved'",t,id),
      this.q('DELETE FROM delivery_units WHERE order_id=?',id),this.q('DELETE FROM deliveries WHERE order_id=?',id),
      this.q('INSERT INTO audit(entity_id,action,created_at) VALUES(?,?,?)',id,'reservation_released',t)
    ]);return {ok:true};
  }
}
