export class StockError extends Error {
  constructor(message,status=400){super(message);this.status=status;}
}
export const STOCK_DEFAULTS={enabled:false,percent:35,intervalMinutes:10,zeroHours:5,thresholdPercent:30,target:''};
export function stockConfig(input={}){
  const c={...STOCK_DEFAULTS,...input};
  if(typeof c.enabled!=='boolean')throw new StockError('Проверьте включение синхронизации.');
  for(const [key,min,max] of [['percent',1,100],['intervalMinutes',10,1440],['zeroHours',0,72],['thresholdPercent',1,100]]){
    if(!Number.isFinite(c[key])||c[key]<min||c[key]>max||(key!=='zeroHours'&&!Number.isInteger(c[key])))throw new StockError(`Проверьте настройку ${key}: от ${min} до ${max}.`);
  }
  if(typeof c.target!=='string'||(c.target&&!/^(campaign|warehouse):[1-9]\d{0,14}$/.test(c.target))||(c.enabled&&!c.target))throw new StockError('Выберите склад Маркета для синхронизации.');
  return Object.fromEntries(Object.keys(STOCK_DEFAULTS).map(k=>[k,c[k]]));
}
// The baseline changes only after a successful update, never after small fluctuations.
export function stockDecision(config,previous,{total,current,now=Date.now()}){
  const state={...previous,lastCheckedAt:now,observedTotal:total,currentMarket:current,error:null};
  if(!Number.isSafeInteger(total)||total<0||!Number.isSafeInteger(current)||current<0)throw new StockError('Не подтверждено количество товара. Остаток не изменён.',502);
  const desired=total===0?0:Math.min(total,Math.ceil(total*config.percent/100));
  state.desired=desired;
  if(total===0){
    const continuous=previous.lastCheckedAt!=null&&now-previous.lastCheckedAt<=config.intervalMinutes*60000*2;
    state.zeroSince=continuous&&previous.zeroSince!=null?previous.zeroSince:now;
    if(current===0)return {state:{...state,reason:'already_zero'},count:null};
    if(now-state.zeroSince<config.zeroHours*3600000)return {state:{...state,reason:'zero_delay'},count:null};
    return {state:{...state,reason:'zero_confirmed'},count:0};
  }
  state.zeroSince=null;
  if(current===desired)return {state:{...state,baselineTotal:previous.baselineTotal??total,reason:'unchanged'},count:null};
  const changed=previous.baselineTotal==null||previous.baselineTotal===0||Math.abs(total-previous.baselineTotal)*100>=previous.baselineTotal*config.thresholdPercent;
  // Refill an exhausted listing; clamp an advertised quantity exceeding known positive stock.
  const refill=current===0||(previous.lastSentCount!=null&&current<previous.lastSentCount&&current<=previous.lastSentCount*(1-config.thresholdPercent/100));
  if(changed||refill||current>total)return {state:{...state,reason:current>total?'stock_drop':refill?'refill':'threshold'},count:desired};
  return {state:{...state,reason:'within_threshold'},count:null};
}
