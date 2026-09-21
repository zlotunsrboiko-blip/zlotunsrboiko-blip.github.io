export function makeMarketMock() {
  const today=new Date().toISOString().slice(0,10);
  const order=(id,status,name,count=1)=>({id,campaignId:149189839,status,creationDate:`${today}T09:20:00+03:00`,fake:false,items:[{id:1,offerId:`DIGITAL-${id}`,offerName:name,count,prices:{payment:{value:1490,currencyId:'RUR'}}}],prices:{payment:{value:1490*count,currencyId:'RUR'}},delivery:{type:'DIGITAL',digitalGoods:{type:'ACTIVATION_CODE'}}});
  const orders=[order(84729105,'PROCESSING','Подписка на онлайн-сервис · 1 месяц'),order(84729083,'PROCESSING','Цифровой сертификат · 1 000 ₽',2),order(84728861,'DELIVERED','Ключ активации программы'),order(84728014,'CANCELLED','Подписка на онлайн-сервис · 3 месяца')];
  const chats=[{chatId:101,context:{type:'ORDER',orderId:84729105,campaignId:149189839,customer:{name:'Александр',publicId:'demo-1'}},type:'CHAT',status:'WAITING_FOR_PARTNER',updatedAt:`${today}T10:42:00+03:00`},{chatId:102,context:{type:'ORDER',orderId:84728861,campaignId:149189839,customer:{name:'Мария',publicId:'demo-2'}},type:'CHAT',status:'WAITING_FOR_CUSTOMER',updatedAt:`${today}T09:32:00+03:00`},{chatId:103,context:{type:'ORDER',orderId:84728014,campaignId:149189839,customer:{name:'Павел'}},type:'CHAT',status:'FINISHED',updatedAt:`${today}T08:30:00+03:00`}];
  const messages={101:[{messageId:1,sender:'CUSTOMER',message:'Здравствуйте! Подскажите, когда придёт код? Хочу активировать подписку сегодня.',createdAt:`${today}T10:40:00+03:00`},{messageId:2,sender:'PARTNER',message:'Здравствуйте! Заказ вижу, сейчас подготовлю данные и инструкцию.',createdAt:`${today}T10:41:00+03:00`},{messageId:3,sender:'CUSTOMER',message:'Спасибо, буду ждать.',createdAt:`${today}T10:42:00+03:00`}],102:[{messageId:4,sender:'CUSTOMER',message:'Всё получилось, спасибо!',createdAt:`${today}T09:32:00+03:00`}],103:[{messageId:5,sender:'MARKET',message:'Заказ отменён.',createdAt:`${today}T08:30:00+03:00`}]};
  const calls=[];
  const fetcher=async (input,options={})=>{
    const url=new URL(input),data=options.body?JSON.parse(options.body):{};calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),data,method:options.method});
    const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
    if(options.headers?.['Api-Key']!=='demo-key')return reply({status:'ERROR'},401);
    if(url.pathname==='/v2/auth/token')return reply({result:{apiKey:{authScopes:['INVENTORY_AND_ORDER_PROCESSING','COMMUNICATION']}}});
    if(url.pathname.endsWith('/deliverDigitalGoods')){const id=Number(url.pathname.split('/').at(-2)),o=orders.find(o=>o.id===id);if(o)o.status='DELIVERED';return reply({status:'OK'});}
    if(url.pathname.endsWith('/buyer'))return reply({result:{id:'demo-1',firstName:'Александр',lastName:'Покупатель',phone:'+7 000 000-00-00'}});
    if(url.pathname.startsWith('/v1/businesses/'))return reply({orders:orders.filter(o=>(!data.statuses||data.statuses.includes(o.status))&&(!data.orderIds||data.orderIds.includes(o.id))&&(!data.dates||(o.creationDate.slice(0,10)>=data.dates.creationDateFrom&&o.creationDate.slice(0,10)<data.dates.creationDateTo))&&(data.fake===undefined||o.fake===data.fake))});
    if(url.pathname.endsWith('/chats'))return reply({result:{chats:chats.filter(c=>(!data.contexts||data.contexts.some(x=>x.id===c.context.orderId))&&(!data.statuses||data.statuses.includes(c.status)))}});
    const chatId=Number(url.searchParams.get('chatId'));
    if(url.pathname.endsWith('/chat'))return reply({result:chats.find(c=>c.chatId===chatId)});
    if(url.pathname.endsWith('/chats/history'))return reply({result:{messages:messages[chatId]||[]}});
    if(url.pathname.endsWith('/chats/message')){(messages[chatId]||=[]).push({messageId:Date.now(),sender:'PARTNER',message:data.message,createdAt:new Date().toISOString()});return reply({status:'OK'});}
    return reply({status:'ERROR'},404);
  };
  return {fetcher,calls,orders,chats,messages};
}
