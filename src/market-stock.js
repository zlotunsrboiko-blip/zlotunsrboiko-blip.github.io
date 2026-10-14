import {StockError} from './stock-policy.js';
const ROOT='https://api.partner.market.yandex.ru';
const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0;
export function marketStocks(env,fetcher=fetch){
  const business=Number(env.YANDEX_BUSINESS_ID),campaign=Number(env.YANDEX_CAMPAIGN_ID);
  async function request(path,data,method='POST'){
    if(!env.YANDEX_API_KEY||!positive(business)||!positive(campaign))throw new StockError('Настройте серверный ключ и ID Маркета.',503);
    let r,value;
    try{r=await fetcher(ROOT+path,{method,headers:{'Api-Key':env.YANDEX_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(20000)});}catch{throw new StockError('Маркет не ответил на запрос остатков. Повторная проверка по расписанию.',502);}
    try{const text=await r.text();value=text?JSON.parse(text):{};}catch{throw new StockError('Маркет вернул непонятный ответ об остатках.',502);}
    if(!r.ok||value.status==='ERROR'||value.errors?.length){
      const status=r.ok?400:r.status;
      throw new StockError(status===403?'Для синхронизации ключу Маркета нужно право «Управление товарами и карточками».':status===401?'Серверный ключ Маркета недействителен.':`Маркет отклонил запрос остатков (HTTP ${status}).`,status);
    }
    return value.result??value;
  }
  async function targets(){
    let version=3,rows=[],page=null;
    for(let i=0;i<10;i++){
      let result;
      try{result=await request(`/v${version}/businesses/${business}/warehouses?limit=30${page?'&pageToken='+encodeURIComponent(page):''}`,version===3?{}:{campaignIds:[campaign]});}
      catch(e){if(version===3&&i===0&&[400,404].includes(e.status)){version=2;i=-1;continue;}throw e;}
      if(!Array.isArray(result.warehouses))throw new StockError('Маркет не подтвердил список складов.',502);
      for(const w of result.warehouses){
        if(!positive(w.id))continue;
        if(version===3){if(w.models?.some(m=>m.placementType==='DBS'&&m.apiAvailability==='AVAILABLE'))rows.push({id:`warehouse:${w.id}`,name:`${w.name||'Склад'} · №${w.id}`});}
        else if(Number(w.campaignId)===campaign)rows.push({id:`campaign:${campaign}`,name:`${w.name||'Склад магазина'} · магазин ${campaign}${w.groupInfo?' · общая группа складов':''}`,warehouseId:w.id});
      }
      page=result.paging?.nextPageToken;if(!page)return [...new Map(rows.map(x=>[x.id,x])).values()];
    }
    throw new StockError('Слишком много страниц складов. Список не подтверждён.',502);
  }
  function targetId(target){const [type,value]=String(target).split(':');if(!['campaign','warehouse'].includes(type)||!positive(value)||(type==='campaign'&&Number(value)!==campaign))throw new StockError('Проверьте склад синхронизации.');return {type,id:Number(value)};}
  async function read(target,offerId){
    const {type,id}=targetId(target);
    const result=await request(type==='campaign'?`/v2/campaigns/${id}/offers/stocks`:`/v3/businesses/${business}/offers/stocks`,{offerIds:[offerId],...(type==='warehouse'?{partnerWarehouseId:id}:{})});
    let offers;
    if(type==='warehouse'){
      if(Number(result.partnerWarehouseId)!==id)throw new StockError('Ответ Маркета относится к другому складу.',502);
      offers=result.offers;
    }else{
      // The campaign endpoint must resolve to exactly one stock source; never sum warehouses.
      const sources=(result.warehouses||[]).filter(w=>w.offers?.some(o=>o.offerId===offerId));
      if(sources.length!==1)throw new StockError('Маркет не подтвердил единственный склад для артикула.',502);
      offers=sources[0].offers;
    }
    const offer=offers?.find(o=>o.offerId===offerId);
    if(!offer)throw new StockError('Маркет не вернул этот артикул на выбранном складе. Проверьте артикул категории.',502);
    const stocks=Array.isArray(offer.stocks)?offer.stocks:[],available=stocks.find(s=>s.type==='AVAILABLE'),fit=stocks.find(s=>s.type==='FIT'),reserved=stocks.find(s=>s.type==='FREEZE');
    const valid=s=>s&&Number.isSafeInteger(s.count)&&s.count>=0;
    if(valid(available))return available.count;
    // FIT includes reserved orders. Subtract only an explicitly confirmed FREEZE count.
    if(!available&&valid(fit)&&valid(reserved)&&fit.count>=reserved.count)return fit.count-reserved.count;
    const details=stocks.filter(s=>['AVAILABLE','FIT','FREEZE'].includes(s.type)).map(s=>`${s.type}: ${valid(s)?s.count:'неизвестно'}`).join(', ');
    throw new StockError(`Маркет не подтвердил доступный остаток артикула${details?' ('+details+')':''}. Изменения не отправлены.`,502);
  }
  async function write(target,offerId,count,at){
    const {type,id}=targetId(target);
    if(!Number.isSafeInteger(count)||count<0||count>2000000000)throw new StockError('Недопустимое количество для Маркета.');
    const updatedAt=new Date(at).toISOString();
    return type==='campaign'?request(`/v2/campaigns/${id}/offers/stocks`,{skus:[{sku:offerId,items:[{count,updatedAt}]}]},'PUT'):request(`/v3/businesses/${business}/offers/stocks/update`,{skuItems:[{sku:offerId,partnerWarehouseId:id,count,updatedAt}]});
  }
  return {targets,read,write};
}
