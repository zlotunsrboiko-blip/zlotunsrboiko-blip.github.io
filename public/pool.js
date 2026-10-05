'use strict';
const poolLabels={available:'Доступен',reserved:'Зарезервирован',sold:'Выдан',blocked:'Заблокирован',prepared:'Подготовлено',sending:'Отправка / требуется проверка',accepted:'Принято Маркетом',uncertain:'Результат неизвестен',rejected:'Отклонено Маркетом'};
const poolShops={mke:{name:'MKE SHOP',icon:'M'},roboticvn:{name:'ROBOTICVN SHOP',icon:'R'}};
const poolFilters={modes:new Set(['unique','reusable']),providers:new Set(['local','mke','roboticvn'])};
let categories=[],supplierShops={mke:{products:[],configured:null},roboticvn:{products:[],configured:null}},poolAutomation=null,poolOffset=0,ledgerOffset=0,poolGeneration=0,ledgerGeneration=0,walletGeneration=0,walletLoading=false;
const post=(path,data)=>api(path,{method:'POST',body:JSON.stringify(data)});
const rub=k=>k===null||k===undefined?'Ожидается сумма':new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB'}).format(k/100);
function shopMoney(value,currency){if(value===null||value===undefined||value===''||!Number.isFinite(Number(value)))return 'Не получен';if(!currency)return `${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:4}).format(Number(value))} · валюта не указана`;try{return new Intl.NumberFormat('ru-RU',{style:'currency',currency}).format(Number(value));}catch{return `${value} ${currency}`;}}
function shopBalances(shop){if(Array.isArray(shop.balances))return shop.balances;if(shop.balances&&typeof shop.balances==='object')return Object.entries(shop.balances).map(([currency,balance])=>({currency,balance}));return shop.balance==null?[]:[{currency:shop.currency,balance:shop.balance}];}
function balanceText(shop){const balances=shopBalances(shop);return balances.length?balances.map(row=>shopMoney(row.balance,row.currency)).join(' · '):'Не получен';}
function categoryProvider(c){return c.supplier_enabled&&!c.reusable?(c.supplier_provider||'mke'):'local';}
function categoryMatches(c){return poolFilters.modes.has(c.reusable?'reusable':'unique')&&poolFilters.providers.has(categoryProvider(c))&&(!$('#pool-category').value||$('#pool-category').value===c.id);}
function poolIcon(text,title,kind){const badge=el('span',`pool-buff ${kind}`,text);badge.title=title;badge.setAttribute('aria-label',title);badge.tabIndex=0;return badge;}
function sourceLabel(provider){return provider==='local'?'Свой пул':poolShops[provider]?.name||'Неизвестный магазин';}
function todayForPool(){const date=new Date();return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
function categoryReadiness(c){
  if(c.activate_till&&c.activate_till<todayForPool())return {tone:'warning',text:'Истёк срок активации',detail:`Исправьте дату ${c.activate_till} в настройках. Выдача блокируется.`};
  if(Number(c.available)>0)return {tone:'ready',text:c.reusable?'Шаблон готов · без ограничений':`${c.available} в своём пуле`,detail:c.reusable?'Одни и те же данные отправляются каждому покупателю.':'Сначала выдаются доступные товары из своего пула.'};
  const provider=categoryProvider(c),shop=supplierShops[provider];
  if(provider==='local')return {tone:'warning',text:c.reusable?'Добавьте шаблон':'Пул пуст',detail:c.reusable?'Нужна одна ссылка или текст для всех заказов.':'Добавьте товар или настройте автозакупку.'};
  if(shop?.statusError)return {tone:'warning',text:'Проверка магазина недоступна',detail:'Баланс не подтверждён. Обновите кошельки.'};
  if(!shop?.configured)return {tone:'warning',text:shop?.configured===false?'Магазин не подключён':'Проверяем магазин',detail:`Нужен ключ ${sourceLabel(provider)} на сервере.`};
  const product=shop.products.find(x=>String(x.id)===String(c.supplier_product_id));
  if(shop.catalogError||!product)return {tone:'warning',text:'Товар магазина не подтверждён',detail:'Откройте настройки категории и проверьте выбранный товар.'};
  if(product.instant===false)return {tone:'warning',text:'Автозакупка недоступна',detail:'Выбранный товар не подходит для автоматической выдачи.'};
  if(product.stock!=null&&Number(product.stock)<=0)return {tone:'warning',text:'У магазина нет остатка',detail:`${sourceLabel(provider)} · ${product.name}`};
  const balance=shopBalances(shop).find(row=>row.currency===product.currency)?.balance,price=product.price;
  if(balance==null||price==null||!Number.isFinite(Number(balance))||!Number.isFinite(Number(price))||!product.currency)return {tone:'warning',text:'Автозакупка настроена',detail:'Достаточность баланса пока не подтверждена.'};
  if(Number(balance)<Number(price))return {tone:'warning',text:'Не хватает баланса',detail:`Пополните кошелёк ${product.currency}. Нужно ${shopMoney(price,product.currency)} за единицу.`};
  return {tone:'ready',text:'Автозакупка доступна',detail:`${shopMoney(price,product.currency)} / шт. · ${product.stock==null?'остаток не указан':`остаток ${product.stock}`}. ${product.instant===null?'Возможна задержка выдачи.':'Проверено для одной единицы.'}`};
}
function renderCategoryCards(){
  const container=$('#category-cards');if(!container)return;container.replaceChildren();
  const visible=categories.filter(categoryMatches);$('#category-count').textContent=`Категории: ${visible.length} из ${categories.length}`;
  for(const c of visible){
    const provider=categoryProvider(c),card=el('article',`card category-card source-${provider}`),head=el('div','category-card-head'),badges=el('div','pool-buffs');
    badges.append(poolIcon(c.reusable?'↻':'1×',c.reusable?'Универсальный: одинаковые данные для всех заказов':'Уникальный: одна единица для одного покупателя',c.reusable?'reusable':'unique'));
    badges.append(poolIcon(provider==='local'?'⌂':poolShops[provider]?.icon||'?',provider==='local'?'Свой пул: без автозакупки':`${sourceLabel(provider)}: автозакупка, когда свой пул пуст`,provider));
    head.append(el('h2','',c.name),badges);
    const sku=el('p','category-sku',c.offer_id);sku.title='Артикул Маркета';
    const product=supplierShops[provider]?.products.find(x=>String(x.id)===String(c.supplier_product_id));
    const shopLine=el('p',`category-shop ${provider}`,sourceLabel(provider));if(provider==='mke')shopLine.append(document.createTextNode(` · #${c.supplier_product_id}`));shopLine.title=provider==='local'?'Закупка отключена':`Автозакупка: ${sourceLabel(provider)}${product?` · ${product.name}`:''}`;
    const ready=categoryReadiness(c),readiness=el('div',`category-readiness ${ready.tone}`);readiness.append(el('strong','',ready.text),el('p','hint',ready.detail));
    const counts=el('p','category-counts',`${c.item_kind==='code'?'Код / текст':'Аккаунт'} · резерв ${c.reserved||0} · выдано ${c.sold||0}${Number(c.blocked)?` · блок ${c.blocked}`:''}`);
    card.append(head,sku,shopLine);if(product)card.append(el('p','category-product',product.name));card.append(readiness,counts,button('Настроить',()=>categoryEditor(c),'button quiet category-edit'));container.append(card);
  }
  if(!visible.length)container.append(el('p','empty',categories.length?'Нет категорий по выбранным фильтрам.':'Создайте категорию, чтобы добавить товары.'));
}
function renderWallets(){
  const root=$('#supplier-wallets');if(!root)return;root.replaceChildren();
  for(const [provider,config] of Object.entries(poolShops)){
    const shop=supplierShops[provider],box=el('section',`supplier-wallet ${provider}`),head=el('div','wallet-head');head.append(poolIcon(config.icon,config.name,provider),el('h2','',config.name));
    const amount=el('strong','wallet-amount',shop.statusError?'Баланс недоступен':shop.configured===false?'Не подключён':balanceText(shop));
    const caption=el('p','hint',shop.statusError?shop.statusError:shop.checkedAt?`Проверен ${formatDate(shop.checkedAt)}`:shop.configured===false?'Добавьте ключ магазина в секреты сервера.':'Получаем баланс…');
    if(shop.statusError&&shopBalances(shop).length)caption.textContent=`${shop.statusError} Последний известный: ${balanceText(shop)}${shop.checkedAt?` · ${formatDate(shop.checkedAt)}`:''}.`;
    box.append(head,amount,caption);root.append(box);
  }
  const refresh=$('#refresh-wallets');if(refresh)refresh.disabled=walletLoading;
}
async function refreshWallets(){
  const generation=++walletGeneration;walletLoading=true;renderWallets();
  await Promise.all(Object.keys(poolShops).map(async provider=>{try{const result=await api(`/api/supplier/status?provider=${provider}`);if(generation!==walletGeneration)return;supplierShops[provider]={...supplierShops[provider],...result,statusError:null};}catch(e){if(generation===walletGeneration)supplierShops[provider]={...supplierShops[provider],statusError:e.message||'Не удалось обновить баланс.'};}}));
  if(generation!==walletGeneration)return;walletLoading=false;renderWallets();renderCategoryCards();
}
function renderPoolAutomation(){
  const text=$('#pool-automation');if(!text)return;
  text.textContent=poolAutomation===null?'Состояние автовыдачи пока не подтверждено.':!poolAutomation.automation?'Автовыдача выключена на сервере.':!poolAutomation.marketKeyConfigured?'Автовыдача включена, но ключ Маркета на сервере не настроен.':'Автовыдача включена: сначала свой пул, затем выбранный магазин. Для MKE SHOP и ROBOTICVN SHOP данные отправляются в Маркет автоматически после получения от магазина.';
  text.className=poolAutomation?.automation&&poolAutomation?.marketKeyConfigured?'pool-automation':'pool-automation warning';
}
function checkboxFilter(title,name,options){
  const root=el('details','checkbox-filter'),summary=el('summary'),panel=el('div','checkbox-filter-options'),labels=new Map(options),refresh=()=>{const selected=[...poolFilters[name]];summary.textContent=`${title}: ${selected.length===options.length?'все':selected.length?selected.map(x=>labels.get(x)).join(', '):'ничего'}`;};
  root.append(summary,panel);for(const [value,label] of options){const line=el('label','check'),check=el('input');check.type='checkbox';check.value=value;check.checked=poolFilters[name].has(value);check.onchange=()=>{check.checked?poolFilters[name].add(value):poolFilters[name].delete(value);refresh();loadPool();};line.append(check,document.createTextNode(label));panel.append(line);}
  root.addEventListener('keydown',event=>{if(event.key==='Escape'){root.open=false;summary.focus();}});refresh();return root;
}
function automationEvent(e){if(e.action.startsWith('finished:')){const delivered=e.action.match(/delivered=(\d+)/)?.[1]||'0',issues=e.action.match(/issues=(\d+)/)?.[1]||'0';return `Проверка завершена: отправлено ${delivered}, ошибок ${issues}`;}if(e.action.startsWith('auto_delivery_failed:'))return `Заказ № ${e.entity_id}: ${e.action.slice('auto_delivery_failed:'.length)}`;if(e.action.startsWith('google_sync_failed:'))return `Google Таблицы: ${e.action.slice('google_sync_failed:'.length)}`;if(e.action.startsWith('market_sync_failed:'))return `Получение заказов: ${e.action.slice('market_sync_failed:'.length)}`;return e.action;}
function dataTable(headers,rows){const box=el('div','table-scroll'),table=el('table','data-table'),head=el('thead'),tr=el('tr');headers.forEach(h=>tr.append(el('th','',h)));head.append(tr);table.append(head);const body=el('tbody');rows.forEach(cells=>{const row=el('tr');cells.forEach(value=>{const td=el('td');td.append(value instanceof Node?value:document.createTextNode(value==null?'—':String(value)));row.append(td);});body.append(row);});table.append(body);box.append(table);return box;}
function dialog(title){const root=el('dialog','editor-dialog'),heading=el('h2','',title),close=button('Закрыть',()=>{root.close();root.remove();},'button quiet');root.addEventListener('close',()=>root.remove(),{once:true});root.append(heading,close);document.body.append(root);root.showModal();return root;}
function submitForm(root,fields,action,title='Сохранить'){
  const form=el('form','stack-form');fields.forEach(f=>form.append(f.label));const error=el('p','error-text'),submit=el('button','button primary',title);submit.type='submit';form.append(error,submit);root.append(form);
  form.addEventListener('submit',async e=>{e.preventDefault();if(submit.disabled||!form.reportValidity())return;submit.disabled=true;error.textContent='';try{await action();root.close?.();}catch(e){error.textContent=e.message;}finally{submit.disabled=false;}});return form;
}
function categoryEditor(current={}){
  const d=dialog(current.id?'Редактировать категорию':'Новая категория');
  const name=field('Название категории','input',{required:true,value:current.name||'',maxLength:150}),kind=field('Что выдавать покупателю','select',{required:true}),mode=field('Режим товара','select'),sku=field('Артикул Маркета','input',{required:true,value:current.offer_id||'',maxLength:300}),slip=field('Инструкция покупателю','textarea',{required:true,rows:4,value:current.slip||'',maxLength:10000}),until=field('Крайняя дата активации','input',{type:'date',required:true,value:current.activate_till||'',min:todayForPool()}),shop=field('Автозакупка, когда свой пул пуст','select'),supplier=field('Товар выбранного магазина','select');
  const shopHelp=el('p','hint category-shop-help'),catalogMore=button('Ещё товары магазина',async()=>{
    const provider=shop.input.value,info=supplierShops[provider],offset=info?.nextOffset;if(provider==='local'||offset==null)return;catalogMore.disabled=true;
    try{const result=await api(`/api/supplier/products?provider=${provider}&offset=${encodeURIComponent(offset)}`),existing=supplierShops[provider];const products=new Map(existing.products.map(product=>[String(product.id),product]));for(const product of result.products||[])products.set(String(product.id),product);supplierShops[provider]={...existing,products:[...products.values()],nextOffset:result.nextOffset??null,total:result.total,catalogError:null};if(shop.input.value===provider)populateProducts(supplier.input.value);renderCategoryCards();}catch(e){shopHelp.textContent=e.message;}finally{catalogMore.disabled=false;}
  },'button quiet');
  shop.input.append(new Option('Свой пул — без автозакупки','local'),...Object.entries(poolShops).map(([id,value])=>new Option(value.name,id)));shop.input.value=categoryProvider(current);
  const populateProducts=(selected='')=>{
    const provider=shop.input.value,info=supplierShops[provider],products=info?.products||[];supplier.input.replaceChildren(new Option('Выберите товар',''));
    products.filter(x=>x.instant!==false).forEach(x=>supplier.input.append(new Option(`${provider==='mke'?`#${x.id} · `:''}${x.name} · ${shopMoney(x.price,x.currency)} · ${x.stock==null?'остаток не указан':`остаток ${x.stock}`}${x.instant===null?' · возможна задержка выдачи':''}`,String(x.id))));
    if(selected&&!Array.from(supplier.input.options).some(option=>option.value===selected))supplier.input.append(new Option(`Сохранённый товар${provider==='mke'?` #${selected}`:''} · не загружен в списке`,selected));
    supplier.input.value=selected;supplier.label.hidden=provider==='local';supplier.input.required=provider!=='local';
    catalogMore.hidden=provider==='local'||info?.nextOffset==null;catalogMore.textContent=`Ещё товары ${sourceLabel(provider)}${info?.total?` · загружено вариантов ${products.length}`:''}`;
    shopHelp.textContent=provider==='local'?'Будут выдаваться только товары, которые вы добавили в пул.':info?.catalogError?`Каталог ${sourceLabel(provider)} не загрузился: ${info.catalogError} Сохранённый товар не заменён.`:info?.configured===false?`Ключ ${sourceLabel(provider)} ещё не подключён на сервере.`:provider==='roboticvn'?'После покупки сервис ждёт данные ROBOTICVN SHOP и отправляет их в Маркет. Если результат покупки неизвестен, автоповтор останавливается для проверки списания.':'При нехватке своего запаса сервис купит выбранный товар MKE SHOP и отправит данные в Маркет.';
  };
  populateProducts(current.supplier_enabled?String(current.supplier_product_id||''):'');
  shop.input.onchange=()=>populateProducts();
  kind.input.append(new Option('Аккаунт: логин, пароль и 2FA','account'),new Option('Код / CDK','code'));kind.input.value=current.item_kind||'account';
  mode.input.append(new Option('Уникальный — каждая единица выдаётся один раз','unique'),new Option('Универсальный — одна ссылка выдаётся всем','reusable'));mode.input.value=current.reusable?'reusable':'unique';
  const adjustMode=()=>{const reusable=mode.input.value==='reusable';if(reusable){kind.input.value='code';shop.input.value='local';populateProducts();}shop.input.disabled=supplier.input.disabled=reusable;kind.input.disabled=reusable||(current.id&&Number(current.available)+Number(current.reserved)+Number(current.sold)+Number(current.blocked)>0);};mode.input.onchange=adjustMode;adjustMode();
  d.append(el('p','hint','Артикул — буквенный код продавца, например ZLOTUN-1111-1. Для каждого магазина товар выбирается отдельно. Смена магазина не переносит выбранный товар.'));
  const form=submitForm(d,[name,kind,mode,sku,slip,until,shop,supplier],async()=>{await post('/api/pool/categories',{id:current.id,name:name.input.value,kind:kind.input.value,offerId:sku.input.value,slip:slip.input.value,activateTill:until.input.value,reusable:mode.input.value==='reusable',supplierProvider:shop.input.value==='local'?'mke':shop.input.value,supplierProductId:shop.input.value==='local'?'':supplier.input.value,supplierEnabled:shop.input.value!=='local'&&Boolean(supplier.input.value)});await loadPool();});form.insertBefore(catalogMore,supplier.label.nextSibling);form.insertBefore(shopHelp,catalogMore.nextSibling);
}
function categoryField(value){const f=field('Категория','select',{required:true});f.input.append(new Option('Выберите категорию',''));categories.forEach(c=>f.input.append(new Option(`${c.name} · ${c.offer_id}`,c.id)));f.input.value=value||'';return f;}
function credentialFields(secret={},fixedKind=null){
  const kind=field('Тип','select');kind.input.append(new Option('Аккаунт','account'),new Option('Код / CDK','code'));kind.input.value=secret.kind||'account';
  const login=field('Логин','input',{value:secret.login||'',autocomplete:'off'}),password=field('Пароль','input',{type:'password',value:secret.password||'',autocomplete:'new-password'}),code=field('Код / CDK','textarea',{value:secret.code||'',rows:2}),twoFactor=field('2FA: резервный код, ссылка или текст','input',{value:secret.twoFactor||'',autocomplete:'off'}),note=field('Примечание для себя (покупателю не отправляется)','textarea',{value:secret.note||'',rows:2});visibilityToggle(password.input);
  const adjust=()=>{const account=kind.input.value==='account';login.label.hidden=password.label.hidden=twoFactor.label.hidden=!account;code.label.hidden=account;login.input.required=password.input.required=account;code.input.required=!account;};kind.input.onchange=adjust;
  const setKind=value=>{kind.input.value=value||'account';kind.input.disabled=Boolean(fixedKind);adjust();};setKind(fixedKind||secret.kind||'account');
  return {fields:[kind,login,password,code,twoFactor,note],setKind,value:()=>({kind:kind.input.value,login:login.input.value,password:password.input.value,code:code.input.value,twoFactor:twoFactor.input.value,note:note.input.value})};
}
function addItem(){if(!categories.length){notice('Сначала создайте категорию и укажите артикул Маркета.');return;}const d=dialog('Добавить товар в пул'),category=categoryField($('#pool-category').value),c=credentialFields({},true);const sync=()=>c.setKind(categories.find(x=>x.id===category.input.value)?.item_kind||'account');category.input.onchange=sync;sync();submitForm(d,[category,...c.fields],async()=>{await post('/api/pool/items',{categoryId:category.input.value,items:[c.value()]});await loadPool();},'Добавить');}
function bulkItems(){
  if(!categories.length){notice('Сначала создайте категорию.');return;}
  const d=dialog('Массовое добавление'),category=categoryField($('#pool-category').value),kind=field('Формат категории','select');kind.input.append(new Option('Коды: один код на строку','code'),new Option('Аккаунты: логин ⇥ пароль ⇥ 2FA','account'));kind.input.disabled=true;
  const data=field('Данные для загрузки','textarea',{rows:10,required:true,spellcheck:false});
  const setExample=()=>{kind.input.value=categories.find(x=>x.id===category.input.value)?.item_kind||'account';data.input.placeholder=kind.input.value==='code'?'AAAA-BBBB-CCCC\nDDDD-EEEE-FFFF':'login@example.com\tпароль123\tрезервный-код-2FA\nlogin2@example.com\tпароль456';};category.input.onchange=setExample;setExample();
  d.append(el('p','hint','Каждая строка станет отдельной единицей товара. Для аккаунтов нужны 2–3 столбца: логин, пароль и необязательный 2FA. Между столбцами должна быть табуляция — удобнее всего скопировать их прямо из Excel.'));
  submitForm(d,[category,kind,data],async()=>{const lines=data.input.value.split(/\r?\n/).filter(x=>x.trim());const items=lines.map(line=>{if(kind.input.value==='code')return {kind:'code',code:line};const parts=line.split('\t');if(parts.length<2||parts.length>3)throw new Error('В каждой строке аккаунта нужны 2–3 столбца через табуляцию.');return {kind:'account',login:parts[0],password:parts[1],twoFactor:parts[2]||''};});await post('/api/pool/items',{categoryId:category.input.value,items});await loadPool();},'Добавить в пул');
}
async function editItem(id){
  try{const row=await post('/api/pool/reveal',{id}),d=dialog('Товар из пула'),c=credentialFields(row.secret);d.append(el('p','hint',`Добавлено ${formatDate(row.created_at)}. Обновлено ${formatDate(row.updated_at)}.`));
    if(!['available','blocked'].includes(row.status)){const pre=el('pre','secret-block');pre.textContent=[row.secret.login||row.secret.code,row.secret.password,row.secret.twoFactor,row.secret.note].filter(Boolean).join('\n');d.append(el('p','hint','Данные зарезервированной или завершённой выдачи сохранены. Для исправления ещё не отправленной выдачи сначала освободите резерв в учёте заказов.'),pre);return;}
    const status=field('Статус','select');status.input.append(new Option('Доступен для выдачи','available'),new Option('Заблокирован','blocked'));status.input.value=row.status;
    submitForm(d,[...c.fields,status],async()=>{await post('/api/pool/edit',{id,version:row.version,status:status.input.value,...c.value()});await loadPool();});
    d.append(button('Удалить из пула',async()=>{if(!confirm('Удалить этот товар из пула без возможности восстановления?'))return;try{await post('/api/pool/delete',{id,version:row.version});d.close();await loadPool();toast('Товар удалён из пула.');}catch(e){notice(e.message);}},'button quiet'));
  }catch(e){notice(e.message);}
}
async function loadPool(more=false){
  const generation=++poolGeneration;try{
    const [cats]=await Promise.all([api('/api/pool/categories'),...Object.keys(poolShops).map(async provider=>{try{const result=await api(`/api/supplier/products?provider=${provider}`);if(generation===poolGeneration)supplierShops[provider]={...supplierShops[provider],products:result.products||[],nextOffset:result.nextOffset??null,total:result.total,catalogError:null};}catch(e){if(generation===poolGeneration)supplierShops[provider]={...supplierShops[provider],catalogError:e.message};}}),refreshWallets(),api('/api/ledger/status').then(status=>{if(generation===poolGeneration)poolAutomation=status;}).catch(()=>{if(generation===poolGeneration)poolAutomation=null;})]);if(generation!==poolGeneration)return;categories=cats.categories;
    const selected=$('#pool-category').value;$('#pool-category').replaceChildren(new Option('Все категории',''));categories.forEach(c=>$('#pool-category').append(new Option(c.name,c.id)));$('#pool-category').value=selected;
    if(!$('#pool-category').value)$('#pool-category').value='';renderCategoryCards();renderPoolAutomation();
    if(!more)poolOffset=0;
    const result=await api('/api/pool/items?'+new URLSearchParams({category:$('#pool-category').value,status:$('#pool-status').value,modes:[...poolFilters.modes].join(','),providers:[...poolFilters.providers].join(','),offset:String(poolOffset)}));if(generation!==poolGeneration)return;
    if(!more)$('#pool-table').replaceChildren();$('#pool-table').append(dataTable(['Категория / закупка','Тип','Статус','Заказ','Добавлено','Обновлено','Данные'],result.items.map(r=>{const category=categories.find(c=>c.id===r.category_id),name=el('div','pool-table-category',r.category);name.append(el('small','',sourceLabel(category?categoryProvider(category):'local')));return [name,r.kind==='account'?'Аккаунт':'CDK',poolLabels[r.status],r.order_id,formatDate(r.created_at),formatDate(r.updated_at),button('Открыть',()=>editItem(r.id),'button quiet')];})));
    if(!result.total){const filtered=!poolFilters.modes.size||!poolFilters.providers.size||poolFilters.modes.size<2||poolFilters.providers.size<3||$('#pool-category').value||$('#pool-status').value;const message=filtered?'Нет товаров по выбранным фильтрам.':categories.length?'Добавьте товар в свой пул или выберите магазин в настройках категории.':'Начните с кнопки «Создать категорию»: укажите название и артикул товара с Маркета.';$('#pool-table').replaceChildren(el('p','empty',message));}$('#pool-more').hidden=result.nextOffset===null;poolOffset=result.nextOffset;$('#pool-total').textContent=`Единиц в списке: ${result.total}`;
  }catch(e){notice(e.message);}
}
async function ledgerDetails(order){
  try{
    const result=await post('/api/ledger/secrets',{orderId:order.id}),d=dialog(`Заказ № ${order.id}`);
    d.append(el('p','hint',`Создан ${formatDate(order.created_at)}. ${poolLabels[order.delivery_state]||'Данные выдачи пока отсутствуют'}.`));
    d.append(dataTable(['Позиция','Единица','Логин / CDK','Пароль','2FA'],result.units.map(u=>[u.item_id,u.unit_index+1,u.secret.login||u.secret.code,u.secret.password,u.secret.twoFactor])));
    if(result.instructions?.length){d.append(el('h3','','Инструкция, отправленная покупателю'));for(const item of result.instructions){const block=el('section','instruction-block'),pre=el('pre','secret-block',item.slip||'Инструкция отсутствует');block.append(el('p','hint',`Позиция ${item.itemId}${item.activateTill?` · Активировать до ${item.activateTill}`:''}`),pre);d.append(block);}}
    if(['prepared','rejected'].includes(order.delivery_state)){
      d.append(el('p','hint',order.delivery_state==='prepared'?'Автовыдача отправит эти данные сама в течение минуты. Кнопка ниже нужна только как аварийный запуск.':'Маркет ранее отклонил отправку. Проверьте данные перед повторным запуском.'));
      d.append(button('Аварийно отправить сейчас',async()=>{if(!confirm('Отправить эти данные покупателю сейчас?'))return;try{await post('/api/deliver',{orderId:order.id});d.close();await loadLedger();}catch(e){toast(e.message);}},'button primary'));
      d.append(button('Освободить резерв для исправления',async()=>{try{await post('/api/pool/release',{orderId:order.id});d.close();await loadLedger();}catch(e){toast(e.message);}}));
    }
    if(['uncertain','sending'].includes(order.delivery_state))d.append(el('p','error-text','Результат отправки требует проверки в Маркете. Товар остаётся в резерве; повторная автоматическая выдача отключена для этого заказа.'));
  }catch(e){notice(e.message);}
}
async function loadLedger(more=false){
  const generation=++ledgerGeneration;try{
    if(!more)ledgerOffset=0;
    const result=await api('/api/ledger?'+new URLSearchParams({orderId:$('#ledger-search').value.trim(),offset:String(ledgerOffset)}));if(generation!==ledgerGeneration)return;
    if(!more)$('#ledger-table').replaceChildren();$('#ledger-table').append(dataTable(['№ заказа','Дата','Маркет','Выдача','Единиц','Цена заказа','Данные'],result.orders.map(o=>[o.id,formatDate(o.created_at),labels[o.status]||o.status,poolLabels[o.delivery_state]||'Не выдавался сервисом',o.units,rub(o.amount_kopecks),button('Открыть',()=>ledgerDetails(o),'button quiet')])));
    if(!result.total)$('#ledger-table').replaceChildren(el('p','empty','Заказы появятся после синхронизации с Маркетом.'));$('#ledger-more').hidden=result.nextOffset===null;ledgerOffset=result.nextOffset;
    const status=await api('/api/ledger/status');if(generation!==ledgerGeneration)return;
    $('#automation-status').textContent=`Автовыдача: ${status.automation?'включена':'выключена'} · Ключ на сервере: ${status.marketKeyConfigured?'настроен':'не задан'} · Google Таблицы: ${status.sheetsConfigured?'настроены':'не подключены'}${status.sheetsLastSuccess?` · Последнее обновление: ${formatDate(status.sheetsLastSuccess)}`:''}`;
    $('#automation-events').replaceChildren(...status.events.map(e=>el('li','hint',`${formatDate(e.created_at)} — ${automationEvent(e)}`)));
  }catch(e){notice(e.message);}
}
function mountPool(){
  for(const [id,title] of [['pool','Пул товаров'],['ledger','Учёт заказов']]){
    const tab=button(title,()=>{switchTab(id);id==='pool'?loadPool():loadLedger();},'tab');tab.dataset.tab=id;$('.tabs').append(tab);
    const panel=el('section','panel');panel.id=id+'-panel';panel.hidden=true;$('#workspace').append(panel);
  }
  $('#pool-panel').innerHTML=`<div class="page-head"><div><p class="eyebrow">ТОВАРЫ И АВТОЗАКУПКА</p><h1>Пул товаров</h1><p class="muted">Свой запас и два магазина — в одном месте.</p></div><button id="refresh-pool" class="button">Обновить всё</button></div>
  <div class="wallets-heading"><span>Кошельки магазинов</span><button id="refresh-wallets" class="button quiet">Обновить баланс</button></div><div id="supplier-wallets" class="supplier-wallets" aria-live="polite"></div><p class="hint wallet-refresh-note">Обновляются раз в минуту, пока эта вкладка открыта. Валюты кошельков учитываются отдельно.</p>
  <p id="pool-automation" class="pool-automation" role="status"></p><details class="pool-guide compact-guide"><summary>Как работает выдача и что означают значки</summary><p>Категория связывает артикул Маркета с данными для покупателя. Уникальный товар (1×) выдаётся один раз, универсальный (↻) повторяется для каждого заказа. Дом (⌂) — только свой пул, M и R — выбранный магазин для автозакупки.</p><p>Сначала используется свой запас. Если он закончился, покупка идёт только в магазин, выбранный в категории. Баланс и остаток показывают возможность купить одну единицу на момент проверки; они могут измениться. Для ROBOTICVN SHOP возможна задержка до получения данных.</p><p>При неизвестном результате покупки или отправки автоматический повтор останавливается. Проверьте «Учёт заказов» и журнал ошибок. Статус «Принято Маркетом» ещё не означает, что покупатель получил письмо.</p><p>В таблице «Закупка» показывает настройку категории, а не происхождение вручную добавленного товара.</p></details>
  <div class="pool-actions"><button id="new-category" class="button primary">Создать категорию</button><button id="new-item" class="button">Добавить товар</button><button id="bulk-items" class="button">Загрузить списком</button></div>
  <div class="pool-filterbar"><div id="pool-multifilters" class="pool-multifilters"></div><label>Категория<select id="pool-category"><option value="">Все категории</option></select></label><button id="pool-reset-filters" class="button quiet">Сбросить</button></div>
  <div class="category-section-head"><h2>Категории</h2><span id="category-count" class="hint"></span></div><div id="category-cards" class="category-grid"></div>
  <div class="pool-stock-head"><h2>Товары в пуле</h2><label>Статус<select id="pool-status"><option value="">Все статусы</option><option value="available">Доступен</option><option value="reserved">В резерве</option><option value="sold">Выдан</option><option value="blocked">Заблокирован</option></select></label><span id="pool-total" class="hint"></span></div><div id="pool-table"></div><button id="pool-more" class="button more" hidden>Ещё товары</button>`;
  $('#ledger-panel').innerHTML='<div class="page-head"><div><p class="eyebrow">СОХРАНЁННЫЕ АВТОМАТИЧЕСКИЕ ВЫДАЧИ</p><h1>Учёт заказов</h1><p class="muted">Здесь видны отправленные данные, инструкция и состояние каждого заказа.</p></div><button id="refresh-ledger" class="button">Обновить</button></div><p id="automation-status" class="hint"></p><details><summary>Журнал автовыдачи и ошибок</summary><p class="hint">Если выдача не состоялась, здесь появятся номер заказа и причина.</p><ul id="automation-events"></ul></details><form id="ledger-filter" class="filters"><label>Номер заказа<input id="ledger-search" inputmode="numeric" placeholder="Все заказы"></label><button class="button">Найти</button></form><div id="ledger-table"></div><button id="ledger-more" class="button more" hidden>Ещё заказы</button>';
  const mountFilters=()=>$('#pool-multifilters').replaceChildren(checkboxFilter('Режим','modes',[['unique','Уникальные'],['reusable','Универсальные']]),checkboxFilter('Закупка','providers',[['local','Свой пул'],['mke','MKE SHOP'],['roboticvn','ROBOTICVN SHOP']]));mountFilters();renderWallets();renderPoolAutomation();
  $('#new-category').onclick=()=>categoryEditor();$('#new-item').onclick=addItem;$('#bulk-items').onclick=bulkItems;$('#refresh-pool').onclick=()=>loadPool();$('#refresh-wallets').onclick=refreshWallets;$('#pool-category').onchange=$('#pool-status').onchange=()=>loadPool();$('#pool-more').onclick=()=>loadPool(true);
  $('#pool-reset-filters').onclick=()=>{poolFilters.modes=new Set(['unique','reusable']);poolFilters.providers=new Set(['local','mke','roboticvn']);$('#pool-category').value=$('#pool-status').value='';mountFilters();loadPool();};
  document.addEventListener('click',event=>{document.querySelectorAll('.checkbox-filter[open]').forEach(filter=>{if(!filter.contains(event.target))filter.open=false;});});
  $('#refresh-ledger').onclick=()=>loadLedger();$('#ledger-more').onclick=()=>loadLedger(true);$('#ledger-filter').onsubmit=e=>{e.preventDefault();loadLedger();};
}
mountPool();
setInterval(()=>{if(!state.credentials||document.hidden||document.querySelector('dialog[open]'))return;if(!$('#ledger-panel').hidden)loadLedger();},30000);
setInterval(()=>{if(state.credentials&&!document.hidden&&!$('#pool-panel').hidden&&!walletLoading)refreshWallets();},60000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.credentials&&!$('#pool-panel').hidden&&!walletLoading)refreshWallets();});
