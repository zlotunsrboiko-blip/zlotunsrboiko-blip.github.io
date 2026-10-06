import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {localDB} from '../src/local-db.js';
import {Inventory} from '../src/inventory.js';

const source=await readFile(new URL('../public/pool.js',import.meta.url),'utf8');
class Element {
  constructor(tag='div',text=''){this.tagName=tag;this.children=[];this.value='';this.dataset={};this.attributes={};this.textContent=text;}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];this._text='';}
  set textContent(value){this._text=value??'';this.children=[];}
  get textContent(){return this._text+this.children.map(node=>typeof node==='string'?node:node.textContent).join(' ');}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(){}
}
function page(api){
  const nodes=new Map(),node=selector=>{if(!nodes.has(selector))nodes.set(selector,new Element());return nodes.get(selector);};
  const el=(tag,kind='',text='')=>Object.assign(new Element(tag,text),{className:kind});
  const context=vm.createContext({api,URLSearchParams,Intl,Date,Map,Set,Node:Element,Option:class extends Element{constructor(text,value){super('option',text);this.value=value;}},$:node,el,button:(text,onclick,kind)=>Object.assign(el('button',kind,text),{onclick}),formatDate:String,notice:()=>{},setInterval:()=>{},state:{credentials:{}},document:{hidden:false,body:new Element(),createTextNode:text=>new Element('text',text),addEventListener(){},querySelector:()=>null,querySelectorAll:()=>[]}});
  vm.runInContext(source,context);
  return {nodes,context,node,run:expression=>vm.runInContext(expression,context)};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const row=(id,category)=>({id,category_id:category,category,kind:'code',status:'available',created_at:'2026-10-05',updated_at:'2026-10-05'});

test('real checkbox selections filter the lower table without waiting for supplier catalogs or balances',async t=>{
  const DB=localDB();t.after(()=>DB.close());
  const store=new Inventory({DB,DATA_ENCRYPTION_KEY:Buffer.alloc(32,12).toString('base64')});
  for(const [name,options] of [['Local',{}],['Universal',{reusable:true}],['MKE',{supplierEnabled:true,supplierProvider:'mke',supplierProductId:4}],['Robotic',{supplierEnabled:true,supplierProvider:'roboticvn',supplierProductId:'rvn:12:monthly:usd'}]]){
    const category=await store.saveCategory({name,kind:'code',offerId:name,slip:'Test instruction',activateTill:'2099-12-31',...options});
    await store.saveItems({categoryId:category.id,items:[{kind:'code',code:'test-'+name}]});
  }
  const calls=[],pending=new Promise(()=>{});
  const ui=page(async path=>{calls.push(path);const url=new URL(path,'https://test.invalid');if(url.pathname==='/api/pool/categories')return {categories:await store.categories()};if(url.pathname==='/api/pool/items')return store.list(url.searchParams);return pending;});
  await ui.context.loadPool();
  assert.match(ui.node('#pool-table').textContent,/Universal/);
  assert.match(ui.node('#pool-table').textContent,/MKE/);
  const backgroundCount=calls.filter(path=>!path.startsWith('/api/pool/')).length;
  const modeFilter=ui.node('#pool-multifilters').children[0],unique=modeFilter.children[1].children[0].children[0];
  unique.checked=false;unique.onchange();
  assert.match(ui.node('#pool-table').textContent,/Загружаем товары/);
  assert.doesNotMatch(ui.node('#pool-table').textContent,/MKE/);
  await flush();await flush();
  assert.match(ui.node('#pool-table').textContent,/Universal/);
  assert.doesNotMatch(ui.node('#pool-table').textContent,/Robotic|MKE/);
  assert.match(ui.node('#pool-total').textContent,/1$/);
  assert.equal(calls.filter(path=>!path.startsWith('/api/pool/')).length,backgroundCount);
  const reusable=modeFilter.children[1].children[1].children[0];reusable.checked=false;reusable.onchange();await flush();await flush();
  assert.match(ui.node('#pool-table').textContent,/Нет товаров по выбранным фильтрам/);
  assert.match(ui.node('#pool-total').textContent,/0$/);
  unique.checked=true;unique.onchange();await flush();await flush();
  const providerFilter=ui.node('#pool-multifilters').children[1];
  for(const index of [0,1]){const check=providerFilter.children[1].children[index].children[0];check.checked=false;check.onchange();}
  await flush();await flush();
  assert.match(ui.node('#pool-table').textContent,/Robotic/);
  assert.doesNotMatch(ui.node('#pool-table').textContent,/Universal|MKE|Local/);
  assert.match(ui.node('#pool-total').textContent,/1$/);
});

test('changing filters clears old pages immediately and ignores late responses from the old selection',async()=>{
  const oldPage=deferred(),requests=[];
  const ui=page(async path=>{const url=new URL(path,'https://test.invalid');if(url.pathname==='/api/pool/items'){requests.push(url.searchParams);if(url.searchParams.get('offset')==='100')return oldPage.promise;const reusable=url.searchParams.get('modes')==='reusable';return {items:[row(reusable?'new':'first',reusable?'universal':'unique')],total:reusable?1:101,nextOffset:reusable?null:100};}throw new Error('Filter must not refresh metadata');});
  ui.run("categories=[{id:'unique',name:'Unique',reusable:false},{id:'universal',name:'Universal',reusable:true}]");
  await ui.context.loadPool(false,false);
  const loadingMore=ui.context.loadPool(true,false);
  ui.run("poolFilters.modes=new Set(['reusable'])");
  const changed=ui.context.loadPool(false,false);
  assert.doesNotMatch(ui.node('#pool-table').textContent,/unique/);
  await changed;
  oldPage.resolve({items:[row('old-page','unique')],total:101,nextOffset:null});await loadingMore;
  assert.match(ui.node('#pool-table').textContent,/universal/);
  assert.doesNotMatch(ui.node('#pool-table').textContent,/unique/);
  assert.equal(requests.at(-1).get('offset'),'0');
  assert.equal(ui.node('#pool-more').hidden,true);
  assert.equal(ui.node('#pool-table').attributes['aria-busy'],'false');
});

test('failed filter request shows an error instead of stale rows and can be retried',async()=>{
  let fail=false;
  const ui=page(async path=>{assert.match(path,/^\/api\/pool\/items\?/);if(fail)throw new Error('Связь потеряна');return {items:[row('first','unique')],total:1,nextOffset:null};});
  ui.run("categories=[{id:'unique',name:'Unique',reusable:false}]");
  await ui.context.loadPool(false,false);fail=true;
  ui.run("poolFilters.providers=new Set(['mke'])");await ui.context.loadPool(false,false);
  assert.match(ui.node('#pool-table').textContent,/Не удалось загрузить товары: Связь потеряна/);
  assert.doesNotMatch(ui.node('#pool-table').textContent,/Unique/);
  assert.equal(ui.node('#pool-more').hidden,true);
  assert.equal(ui.node('#pool-total').textContent,'Список не загружен');
  fail=false;await ui.node('#pool-table').children[1].onclick();
  assert.match(ui.node('#pool-table').textContent,/unique/);
  assert.equal(ui.node('#pool-table').attributes['aria-busy'],'false');
});
