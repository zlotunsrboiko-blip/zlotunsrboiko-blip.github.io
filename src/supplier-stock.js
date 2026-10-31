import {supplierProducts,supplierAccount,SupplierError} from './supplier.js';
import {roboticStock,roboticAccount} from './roboticvn.js';
const cached=(cache,key,fn)=>{if(!cache.has(key))cache.set(key,fn());return cache.get(key);};
export async function supplierStock(env,category,fetcher=fetch,cache=new Map()){
  if(!category.supplier_enabled||category.reusable)return {stock:0};
  if(category.supplier_provider==='roboticvn')return cached(cache,'robotic:'+category.supplier_product_id,()=>roboticStock(env,category.supplier_product_id,fetcher));
  const products=await cached(cache,'mke-products',()=>supplierProducts(env,fetcher));
  if(!Array.isArray(products))throw new SupplierError('MKE SHOP не подтвердил остатки.','supplier_response');
  const product=products.find(p=>String(p.id)===String(category.supplier_product_id));
  if(!product)throw new SupplierError('Выбранный товар MKE SHOP не найден. Остаток не подтверждён.','supplier_product',409);
  const stock=product.instant===false?0:product.stock;
  if(!Number.isSafeInteger(stock)||stock<0)throw new SupplierError('MKE SHOP не сообщил точный остаток.','supplier_response');
  return {stock,price:product.price_usd,currency:'USD'};
}
export async function affordableSupplierStock(env,category,fetcher=fetch,cache=new Map()){
  const item=await supplierStock(env,category,fetcher,cache);
  if(!category.supplier_enabled||category.reusable)return {...item,available:0,affordable:0,balanceLimited:false};
  if(!Number.isSafeInteger(item.stock)||item.stock<0||!Number.isFinite(item.price)||item.price<0)throw new SupplierError('Поставщик не подтвердил цену или остаток товара.','supplier_response');
  const provider=category.supplier_provider==='roboticvn'?'roboticvn':'mke';
  const account=await cached(cache,'wallet:'+provider,()=>provider==='roboticvn'?roboticAccount(env,fetcher):supplierAccount(env,fetcher));
  const balance=account.balances?.find(b=>b.currency===item.currency)?.balance??(account.currency===item.currency?account.balance:undefined);
  if(!Number.isFinite(balance)||balance<0)throw new SupplierError('Поставщик не подтвердил баланс кошелька.','supplier_response');
  const affordable=item.price===0?item.stock:Math.max(0,Math.floor((balance+Number.EPSILON*Math.max(1,balance))/item.price));
  return {...item,balance,affordable,available:Math.min(item.stock,affordable),balanceLimited:affordable<item.stock};
}
// A fallback is allowed only before checkout. Existing purchases never pass here.
export async function canBuyBeforeCheckout(env,category,quantity,fetcher=fetch){
  const item=await supplierStock(env,category,fetcher);
  if(item.stock<quantity)return false;
  const account=category.supplier_provider==='roboticvn'?await roboticAccount(env,fetcher):await supplierAccount(env,fetcher);
  const balance=account.balances?.find(b=>b.currency===item.currency)?.balance??(account.currency===item.currency?account.balance:undefined);
  if(!Number.isFinite(item.price)||item.price<0||!Number.isFinite(balance))throw new SupplierError('Не удалось подтвердить баланс и цену перед закупкой.','supplier_response');
  return balance>=item.price*quantity;
}
