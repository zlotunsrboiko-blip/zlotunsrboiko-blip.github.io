import {unseal} from './inventory.js';
const enc=new TextEncoder();
const serialDate=v=>v&&Number.isFinite(Date.parse(v))?(Date.parse(v)+5*3600000)/86400000+25569:'';
const b64url=v=>btoa(String.fromCharCode(...v)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
async function token(env,fetcher){
  const account=JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const iat=Math.floor(Date.now()/1000);
  const head=b64url(enc.encode(JSON.stringify({alg:'RS256',typ:'JWT'})));
  const claim=b64url(enc.encode(JSON.stringify({iss:account.client_email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',iat,exp:iat+3600})));
  const pk=Uint8Array.from(atob(account.private_key.replace(/-----[^-]+-----|\s/g,'')),c=>c.charCodeAt(0));
  const key=await crypto.subtle.importKey('pkcs8',pk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const sig=b64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,enc.encode(head+'.'+claim))));
  const response=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:head+'.'+claim+'.'+sig}),signal:AbortSignal.timeout(15000)});
  const result=await response.json();if(!response.ok||!result.access_token)throw new Error('Google authentication failed');return result.access_token;
}
export async function sheetRows(store){
  const key=await store.key();
  const orders=(await store.q(`SELECT o.*,d.state AS delivery_state,u.item_id,u.unit_index,u.secret FROM orders o
    LEFT JOIN deliveries d ON d.order_id=o.id LEFT JOIN delivery_units u ON u.order_id=o.id
    ORDER BY o.created_at,o.id,u.item_id,u.unit_index`).all()).results;
  const inventory=(await store.q('SELECT i.*,c.name AS category,c.offer_id FROM inventory i JOIN categories c ON c.id=i.category_id ORDER BY i.created_at,i.id').all()).results;
  const orderRows=[['№ заказа','Дата заказа','Статус Маркета','Выдача','ID позиции','№ единицы','Логин / CDK','Пароль','2FA','Цена заказа, ₽','Выплата после комиссий, ₽','Обновлено','Тестовый заказ']];
  let previous=null;
  for(const row of orders){
    const c=row.secret?await unseal(key,row.secret):{},first=previous!==row.id;previous=row.id;
    orderRows.push([row.id,serialDate(row.created_at),row.status,row.delivery_state||'',row.item_id||'',row.unit_index==null?'':row.unit_index+1,c.login||c.code||'',c.password||'',c.twoFactor||'',first&&row.amount_kopecks!==null?row.amount_kopecks/100:'',first&&row.payout_kopecks!==null?row.payout_kopecks/100:'',serialDate(row.updated_at),row.fake?'Да':'Нет']);
  }
  const poolRows=[['ID товара','Категория','Артикул Маркета','Тип','Статус','№ заказа','Логин / CDK','Пароль','2FA','Добавлено','Обновлено','Примечание']];
  for(const row of inventory){const c=await unseal(key,row.secret);poolRows.push([row.id,row.category,row.offer_id,row.kind,row.status,row.order_id||'',c.login||c.code||'',c.password||'',c.twoFactor||'',serialDate(row.created_at),serialDate(row.updated_at),c.note||'']);}
  return {orders:orderRows,pool:poolRows};
}
export async function syncSheets(store,env,fetcher=fetch){
  if(env.GOOGLE_APPS_SCRIPT_URL&&env.SHEETS_SYNC_SECRET){
    const rows=await sheetRows(store);
    const response=await fetcher(env.GOOGLE_APPS_SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({secret:env.SHEETS_SYNC_SECRET,...rows}),signal:AbortSignal.timeout(20000)});
    let result={};try{result=await response.json();}catch{}
    if(!response.ok||!result.ok)throw new Error('Google Sheets sync failed');
    const time=new Date().toISOString();
    await store.q("INSERT INTO jobs VALUES('sheets_last_success',?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",time,time).run();
    return {configured:true,ok:true};
  }
  if(!env.GOOGLE_SHEET_ID||!env.GOOGLE_SERVICE_ACCOUNT_JSON)return {configured:false};
  const tokenValue=await token(env,fetcher),root=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEET_ID)}`;
  async function call(suffix,body,method='POST'){
    const r=await fetcher(root+suffix,{method,headers:{Authorization:`Bearer ${tokenValue}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    if(!r.ok)throw new Error('Google Sheets sync failed');return r.json();
  }
  const meta=await call('?fields=sheets.properties',undefined,'GET');
  // The two reserved tabs are mirrors owned by the app. Imported historic tabs are untouched.
  const data=await sheetRows(store),requests=[];
  for(const [title,values] of [['Заказы — авто',data.orders],['Пул — авто',data.pool]]){
    let props=meta.sheets?.find(s=>s.properties.title===title)?.properties;
    if(!props){const created=await call(':batchUpdate',{requests:[{addSheet:{properties:{title}}}]});props=created.replies[0].addSheet.properties;}
    const sheetId=props.sheetId,width=values[0].length,height=values.length;
    if(height>50000)throw new Error('Google Sheets mirror exceeds configured size');
    requests.push({updateSheetProperties:{properties:{sheetId,gridProperties:{rowCount:Math.max(height,props.gridProperties.rowCount),columnCount:Math.max(width,props.gridProperties.columnCount),frozenRowCount:1}},fields:'gridProperties'}});
    // One atomic update clears old mirror values and writes the complete snapshot. Explicit stringValue prevents formula injection.
    requests.push({updateCells:{range:{sheetId,startRowIndex:0,endRowIndex:Math.max(height,props.gridProperties.rowCount),startColumnIndex:0,endColumnIndex:width},rows:values.map(row=>({values:row.map(v=>({userEnteredValue:typeof v==='number'?{numberValue:v}:{stringValue:String(v)}}))})),fields:'userEnteredValue'}});
    requests.push({repeatCell:{range:{sheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:width},cell:{userEnteredFormat:{backgroundColor:{red:.94,green:.94,blue:.94},textFormat:{bold:true},wrapStrategy:'WRAP'}},fields:'userEnteredFormat'}});
    requests.push({updateDimensionProperties:{range:{sheetId,dimension:'COLUMNS',startIndex:0,endIndex:width},properties:{pixelSize:190},fields:'pixelSize'}});
    if(height>1){
      for(const col of (title==='Заказы — авто'?[1,11]:[9,10]))requests.push({repeatCell:{range:{sheetId,startRowIndex:1,endRowIndex:height,startColumnIndex:col,endColumnIndex:col+1},cell:{userEnteredFormat:{numberFormat:{type:'DATE_TIME',pattern:'dd.mm.yyyy hh:mm'}}},fields:'userEnteredFormat.numberFormat'}});
      if(title==='Заказы — авто')requests.push({repeatCell:{range:{sheetId,startRowIndex:1,endRowIndex:height,startColumnIndex:9,endColumnIndex:11},cell:{userEnteredFormat:{numberFormat:{type:'NUMBER',pattern:'#,##0.00'}}},fields:'userEnteredFormat.numberFormat'}});
    }
    requests.push({setBasicFilter:{filter:{range:{sheetId,startRowIndex:0,endRowIndex:Math.max(height,2),startColumnIndex:0,endColumnIndex:width}}}});
  }
  await call(':batchUpdate',{requests});
  await store.q("INSERT INTO jobs VALUES('sheets_last_success',?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",new Date().toISOString(),new Date().toISOString()).run();
  return {configured:true,ok:true};
}
