'use strict';
const poolLabels={available:'Доступен',reserved:'Зарезервирован',sold:'Выдан',blocked:'Заблокирован',prepared:'Подготовлено',sending:'Отправка / требуется проверка',accepted:'Принято Маркетом',uncertain:'Результат неизвестен',rejected:'Отклонено Маркетом'};
let categories=[],poolOffset=0,ledgerOffset=0,poolGeneration=0,ledgerGeneration=0;
const post=(path,data)=>api(path,{method:'POST',body:JSON.stringify(data)});
const rub=k=>k===null||k===undefined?'Ожидается сумма':new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB'}).format(k/100);
function dataTable(headers,rows){const box=el('div','table-scroll'),table=el('table','data-table'),head=el('thead'),tr=el('tr');headers.forEach(h=>tr.append(el('th','',h)));head.append(tr);table.append(head);const body=el('tbody');rows.forEach(cells=>{const row=el('tr');cells.forEach(value=>{const td=el('td');td.append(value instanceof Node?value:document.createTextNode(value==null?'—':String(value)));row.append(td);});body.append(row);});table.append(body);box.append(table);return box;}
function dialog(title){const root=el('dialog','editor-dialog'),heading=el('h2','',title),close=button('Закрыть',()=>{root.close();root.remove();},'button quiet');root.addEventListener('close',()=>root.remove(),{once:true});root.append(heading,close);document.body.append(root);root.showModal();return root;}
function submitForm(root,fields,action,title='Сохранить'){
  const form=el('form','stack-form');fields.forEach(f=>form.append(f.label));const error=el('p','error-text'),submit=el('button','button primary',title);submit.type='submit';form.append(error,submit);root.append(form);
  form.addEventListener('submit',async e=>{e.preventDefault();if(submit.disabled||!form.reportValidity())return;submit.disabled=true;error.textContent='';try{await action();root.close?.();}catch(e){error.textContent=e.message;}finally{submit.disabled=false;}});return form;
}
function categoryEditor(current={}){
  const d=dialog(current.id?'Редактировать категорию':'Новая категория');
  const name=field('Название категории','input',{required:true,value:current.name||'',maxLength:150}),sku=field('Артикул товара в Маркете (offerId)','input',{required:true,value:current.offer_id||'',maxLength:300}),slip=field('Инструкция покупателю','textarea',{required:true,rows:4,value:current.slip||'',maxLength:10000}),until=field('Крайняя дата активации','input',{type:'date',required:true,value:current.activate_till||''});
  d.append(el('p','hint','Для каждого артикула создайте свою категорию. Автовыдача выбирает самый ранний доступный товар.'));
  submitForm(d,[name,sku,slip,until],async()=>{await post('/api/pool/categories',{id:current.id,name:name.input.value,offerId:sku.input.value,slip:slip.input.value,activateTill:until.input.value});await loadPool();});
}
function categoryField(value){const f=field('Категория','select',{required:true});f.input.append(new Option('Выберите категорию',''));categories.forEach(c=>f.input.append(new Option(`${c.name} · ${c.offer_id}`,c.id)));f.input.value=value||'';return f;}
function credentialFields(secret={}){
  const kind=field('Тип','select');kind.input.append(new Option('Аккаунт','account'),new Option('Код / CDK','code'));kind.input.value=secret.kind||'account';
  const login=field('Логин','input',{value:secret.login||'',autocomplete:'off'}),password=field('Пароль','input',{type:'password',value:secret.password||'',autocomplete:'new-password'}),code=field('Код / CDK','textarea',{value:secret.code||'',rows:2}),twoFactor=field('2FA: резервный код, ссылка или текст','input',{value:secret.twoFactor||'',autocomplete:'off'}),note=field('Примечание для себя (покупателю не отправляется)','textarea',{value:secret.note||'',rows:2});
  const adjust=()=>{const account=kind.input.value==='account';login.label.hidden=password.label.hidden=twoFactor.label.hidden=!account;code.label.hidden=account;login.input.required=password.input.required=account;code.input.required=!account;};kind.input.onchange=adjust;adjust();
  return {fields:[kind,login,password,code,twoFactor,note],value:()=>({kind:kind.input.value,login:login.input.value,password:password.input.value,code:code.input.value,twoFactor:twoFactor.input.value,note:note.input.value})};
}
function addItem(){if(!categories.length){notice('Сначала создайте категорию и укажите артикул Маркета.');return;}const d=dialog('Добавить товар в пул'),category=categoryField($('#pool-category').value),c=credentialFields();submitForm(d,[category,...c.fields],async()=>{await post('/api/pool/items',{categoryId:category.input.value,items:[c.value()]});await loadPool();},'Добавить');}
function bulkItems(){
  if(!categories.length){notice('Сначала создайте категорию.');return;}
  const d=dialog('Массовое добавление'),category=categoryField($('#pool-category').value),kind=field('Формат','select');kind.input.append(new Option('Коды: один код на строку','code'),new Option('Аккаунты: логин ⇥ пароль ⇥ 2FA','account'));
  const data=field('До 100 товаров. Для аккаунтов вставьте столбцы из Excel через табуляцию.','textarea',{rows:10,required:true,spellcheck:false});
  submitForm(d,[category,kind,data],async()=>{const lines=data.input.value.split(/\r?\n/).filter(x=>x.trim());const items=lines.map(line=>{if(kind.input.value==='code')return {kind:'code',code:line};const parts=line.split('\t');if(parts.length<2||parts.length>3)throw new Error('В каждой строке аккаунта нужны 2–3 столбца через табуляцию.');return {kind:'account',login:parts[0],password:parts[1],twoFactor:parts[2]||''};});await post('/api/pool/items',{categoryId:category.input.value,items});await loadPool();},'Добавить в пул');
}
async function editItem(id){
  try{const row=await post('/api/pool/reveal',{id}),d=dialog('Товар из пула'),c=credentialFields(row.secret);d.append(el('p','hint',`Добавлено ${formatDate(row.created_at)}. Обновлено ${formatDate(row.updated_at)}.`));
    if(!['available','blocked'].includes(row.status)){const pre=el('pre','secret-block');pre.textContent=[row.secret.login||row.secret.code,row.secret.password,row.secret.twoFactor,row.secret.note].filter(Boolean).join('\n');d.append(el('p','hint','Данные зарезервированной или завершённой выдачи сохранены. Для исправления ещё не отправленной выдачи сначала освободите резерв в учёте заказов.'),pre);return;}
    const status=field('Статус','select');status.input.append(new Option('Доступен для выдачи','available'),new Option('Заблокирован','blocked'));status.input.value=row.status;
    submitForm(d,[...c.fields,status],async()=>{await post('/api/pool/edit',{id,version:row.version,status:status.input.value,...c.value()});await loadPool();});
  }catch(e){notice(e.message);}
}
async function loadPool(more=false){
  const generation=++poolGeneration;try{
    const cats=await api('/api/pool/categories');if(generation!==poolGeneration)return;categories=cats.categories;
    const selected=$('#pool-category').value;$('#pool-category').replaceChildren(new Option('Все категории',''));categories.forEach(c=>$('#pool-category').append(new Option(c.name,c.id)));$('#pool-category').value=selected;
    $('#category-cards').replaceChildren();categories.forEach(c=>{const card=el('article','card category-card');card.append(el('h2','',c.name),el('p','hint',c.offer_id),el('strong','',`${c.available} доступно`),el('p','hint',`В резерве: ${c.reserved} · Выдано: ${c.sold} · Блок: ${c.blocked}`),button('Настроить',()=>categoryEditor(c),'button quiet'));$('#category-cards').append(card);});
    if(!more)poolOffset=0;
    const result=await api('/api/pool/items?'+new URLSearchParams({category:$('#pool-category').value,status:$('#pool-status').value,offset:String(poolOffset)}));if(generation!==poolGeneration)return;
    if(!more)$('#pool-table').replaceChildren();$('#pool-table').append(dataTable(['Категория','Тип','Статус','Заказ','Добавлено','Обновлено','Данные'],result.items.map(r=>[r.category,r.kind==='account'?'Аккаунт':'CDK',poolLabels[r.status],r.order_id,formatDate(r.created_at),formatDate(r.updated_at),button('Открыть',()=>editItem(r.id),'button quiet')])));
    if(!result.total)$('#pool-table').replaceChildren(el('p','empty','Пул пуст. Добавьте аккаунты или коды.'));$('#pool-more').hidden=result.nextOffset===null;poolOffset=result.nextOffset;$('#pool-total').textContent=`Товаров: ${result.total}`;
  }catch(e){notice(e.message);}
}
async function ledgerDetails(order){
  try{
    const result=await post('/api/ledger/secrets',{orderId:order.id}),d=dialog(`Заказ № ${order.id}`);
    d.append(el('p','hint',`Создан ${formatDate(order.created_at)}. ${poolLabels[order.delivery_state]||'Данные выдачи пока отсутствуют'}.`));
    d.append(dataTable(['Позиция','Единица','Логин / CDK','Пароль','2FA'],result.units.map(u=>[u.item_id,u.unit_index+1,u.secret.login||u.secret.code,u.secret.password,u.secret.twoFactor])));
    if(['prepared','rejected'].includes(order.delivery_state)){
      d.append(button('Отправить сохранённые данные',async()=>{if(!confirm('Отправить эти данные покупателю?'))return;try{await post('/api/deliver',{orderId:order.id});d.close();await loadLedger();}catch(e){toast(e.message);}},'button primary'));
      d.append(button('Освободить резерв для исправления',async()=>{try{await post('/api/pool/release',{orderId:order.id});d.close();await loadLedger();}catch(e){toast(e.message);}}));
    }
    if(['uncertain','sending'].includes(order.delivery_state))d.append(el('p','error-text','Результат отправки требует проверки в Маркете. Товар остаётся в резерве; повторная автоматическая выдача отключена для этого заказа.'));
    const payout=field('Фактическая выплата после комиссии, ₽','input',{inputMode:'decimal',value:order.payout_kopecks==null?'':String(order.payout_kopecks/100),placeholder:'Пока неизвестна'});
    d.append(el('p','hint','Укажите сумму из финансового отчёта Маркета. Цена заказа не подставляется вместо выплаты. Пустое поле означает, что выплата ещё не сверена.'));
    submitForm(d,[payout],async()=>{await post('/api/ledger/payout',{orderId:order.id,payout:payout.input.value});await loadLedger();},'Сохранить выплату');
  }catch(e){notice(e.message);}
}
async function loadLedger(more=false){
  const generation=++ledgerGeneration;try{
    if(!more)ledgerOffset=0;
    const result=await api('/api/ledger?'+new URLSearchParams({orderId:$('#ledger-search').value.trim(),offset:String(ledgerOffset)}));if(generation!==ledgerGeneration)return;
    if(!more)$('#ledger-table').replaceChildren();$('#ledger-table').append(dataTable(['№ заказа','Дата','Маркет','Выдача','Единиц','Цена заказа','После комиссий','Данные'],result.orders.map(o=>[o.id,formatDate(o.created_at),labels[o.status]||o.status,poolLabels[o.delivery_state]||'Не выдавался сервисом',o.units,rub(o.amount_kopecks),rub(o.payout_kopecks),button('Открыть',()=>ledgerDetails(o),'button quiet')])));
    if(!result.total)$('#ledger-table').replaceChildren(el('p','empty','Заказы появятся после синхронизации с Маркетом.'));$('#ledger-more').hidden=result.nextOffset===null;ledgerOffset=result.nextOffset;
    const status=await api('/api/ledger/status');if(generation!==ledgerGeneration)return;
    $('#automation-status').textContent=`Автовыдача: ${status.automation?'включена':'выключена'} · Ключ на сервере: ${status.marketKeyConfigured?'настроен':'не задан'} · Google Таблицы: ${status.sheetsConfigured?'настроены':'не подключены'}`;
    $('#automation-events').replaceChildren(...status.events.map(e=>el('li','hint',`${formatDate(e.created_at)} — ${e.action}`)));
  }catch(e){notice(e.message);}
}
function mountPool(){
  for(const [id,title] of [['pool','Пул товаров'],['ledger','Учёт заказов']]){
    const tab=button(title,()=>{switchTab(id);id==='pool'?loadPool():loadLedger();},'tab');tab.dataset.tab=id;$('.tabs').append(tab);
    const panel=el('section','panel');panel.id=id+'-panel';panel.hidden=true;$('#workspace').append(panel);
  }
  $('#pool-panel').innerHTML='<div class="page-head"><div><p class="eyebrow">ВАШ ЗАПАС ЦИФРОВЫХ ТОВАРОВ</p><h1>Пул товаров</h1><p class="muted">Категории, доступные аккаунты и коды, даты добавления и изменения.</p></div></div><div class="pool-actions"><button id="new-category" class="button">Новая категория</button><button id="new-item" class="button primary">Добавить товар</button><button id="bulk-items" class="button">Вставить из таблицы</button><button id="refresh-pool" class="button">Обновить</button></div><div id="category-cards" class="category-grid"></div><div class="filters"><label>Категория<select id="pool-category"><option value="">Все категории</option></select></label><label>Статус<select id="pool-status"><option value="">Все статусы</option><option value="available">Доступен</option><option value="reserved">В резерве</option><option value="sold">Выдан</option><option value="blocked">Заблокирован</option></select></label><span id="pool-total"></span></div><div id="pool-table"></div><button id="pool-more" class="button more" hidden>Ещё товары</button>';
  $('#ledger-panel').innerHTML='<div class="page-head"><div><p class="eyebrow">СОХРАНЁННЫЕ ВЫДАЧИ И ВЫПЛАТЫ</p><h1>Учёт заказов</h1><p class="muted">Данные выдачи сохраняются вместе с заказом. Выплата после комиссий — отдельная сумма.</p></div><button id="refresh-ledger" class="button">Обновить</button></div><p id="automation-status" class="hint"></p><details><summary>Последние фоновые проверки</summary><ul id="automation-events"></ul></details><form id="ledger-filter" class="filters"><label>Номер заказа<input id="ledger-search" inputmode="numeric" placeholder="Все заказы"></label><button class="button">Найти</button></form><div id="ledger-table"></div><button id="ledger-more" class="button more" hidden>Ещё заказы</button>';
  $('#new-category').onclick=()=>categoryEditor();$('#new-item').onclick=addItem;$('#bulk-items').onclick=bulkItems;$('#refresh-pool').onclick=()=>loadPool();$('#pool-category').onchange=$('#pool-status').onchange=()=>loadPool();$('#pool-more').onclick=()=>loadPool(true);
  $('#refresh-ledger').onclick=()=>loadLedger();$('#ledger-more').onclick=()=>loadLedger(true);$('#ledger-filter').onsubmit=e=>{e.preventDefault();loadLedger();};
}
mountPool();
setInterval(()=>{if(!state.credentials||document.hidden||document.querySelector('dialog[open]'))return;if(!$('#ledger-panel').hidden)loadLedger();},30000);
