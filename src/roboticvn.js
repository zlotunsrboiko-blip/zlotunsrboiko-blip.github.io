import {SupplierError} from './supplier.js';

const ROOT = 'https://api.roboticvn.com';
const SHOP = 'ROBOTICVN SHOP';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = value => Number.isSafeInteger(value) && value > 0;
const invalid = () => new SupplierError(`${SHOP} вернул неполные данные. Проверьте закупку в магазине.`, 'supplier_response', 502);

async function request(env, path, options = {}, fetcher = fetch, purchase = false) {
  if (!env.ROBOTICVN_API_KEY) throw new SupplierError(`Ключ ${SHOP} не настроен.`, 'supplier_not_configured', 503);
  let response, payload;
  try {
    response = await fetcher(`${ROOT}${path}${path.includes('?') ? '&' : '?'}locale=en-US`, {
      ...options,
      headers: {'x-api-key': env.ROBOTICVN_API_KEY, Accept: 'application/json', 'Content-Type': 'application/json'},
      signal: AbortSignal.timeout(25000),
    });
    try { payload = await response.json(); } catch { payload = null; }
  } catch {
    const error = new SupplierError(`${SHOP} временно недоступен.`, 'supplier_unavailable', 502);
    if (purchase) error.uncertain = true;
    throw error;
  }
  if (!response.ok) {
    const upstreamCode = typeof payload?.error?.code === 'string' ? payload.error.code.toLowerCase() : '';
    const known = {
      insufficient_balance: `Недостаточно средств в кошельке ${SHOP}.`,
      insufficient_funds: `Недостаточно средств в кошельке ${SHOP}.`,
      out_of_stock: `В ${SHOP} закончился выбранный товар.`,
      product_unavailable: `Товар ${SHOP} сейчас недоступен.`,
      invalid_key: `Ключ ${SHOP} недействителен.`,
      invalid_api_key: `Ключ ${SHOP} недействителен.`,
      rate_limited: `${SHOP} ограничил частоту запросов.`,
    };
    const fallback = response.status === 401 ? `Ключ ${SHOP} недействителен.` : response.status === 429 ? `${SHOP} ограничил частоту запросов.` : `${SHOP} отклонил запрос (HTTP ${response.status}).`;
    const code = Object.hasOwn(known, upstreamCode) ? upstreamCode : 'supplier_error';
    const error = new SupplierError(known[upstreamCode] || fallback, code, response.status);
    // No idempotency key or external order reference is documented for this checkout.
    if (purchase && (response.status >= 500 || [408, 409, 425].includes(response.status))) error.uncertain = true;
    throw error;
  }
  if (!isObject(payload) || payload.error) {
    const error = invalid();
    if (purchase) error.uncertain = true;
    throw error;
  }
  return payload;
}

function productKey(productId, variantId, currency) {
  return `rvn:${encodeURIComponent(productId)}:${encodeURIComponent(variantId)}:${currency}`;
}

function decodeProduct(value) {
  try {
    const parts = String(value).split(':');
    if (parts.length !== 4 || parts[0] !== 'rvn' || !['usd', 'vnd'].includes(parts[3])) throw new Error();
    const productId = decodeURIComponent(parts[1]), variantId = decodeURIComponent(parts[2]);
    if (!productId || !variantId || productId.length > 300 || variantId.length > 300) throw new Error();
    return {productId, variantId, currency: parts[3]};
  } catch {
    throw new SupplierError(`Выберите товар и вариант ${SHOP} заново.`, 'supplier_product', 400);
  }
}

function validateQuantity(quantity) {
  if (!integer(quantity) || quantity > 10000) throw new SupplierError('Проверьте количество товара: от 1 до 10000.', 'supplier_quantity', 400);
}

export async function roboticAccount(env, fetcher = fetch) {
  const wallet = await request(env, '/api/v2/wallet/balance', {}, fetcher);
  if (!isObject(wallet.data)) throw invalid();
  const balances = Object.entries(wallet.data).filter(([currency, balance]) => /^[a-z]{3}$/i.test(currency) && amount(balance))
    .map(([currency, balance]) => ({balance, currency: currency.toUpperCase()}));
  if (!balances.length) throw invalid();
  const preferred = balances.find(item => item.currency === 'USD') || balances.find(item => item.currency === 'VND') || balances[0];
  return {...preferred, balances};
}

export async function roboticProducts(env, fetcher = fetch, {offset = 0, limit = 15} = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 15) throw new SupplierError('Проверьте страницу каталога ROBOTICVN SHOP.', 'supplier_catalog_page', 400);
  const page = await request(env, `/api/v2/products?limit=${limit}&offset=${offset}`, {}, fetcher);
  if (!Array.isArray(page.data) || page.data.length > limit || page.data.some(item => typeof item?.id !== 'string' || !item.id)) throw invalid();
  const summaries = page.data;
  const total = Number.isSafeInteger(page.meta?.count) && page.meta.count >= 0 ? page.meta.count : null;
  const products = [];
  // Bound concurrency so opening the pool does not flood the supplier with detail requests.
  for (let start = 0; start < summaries.length; start += 5) {
    const details = await Promise.all(summaries.slice(start, start + 5).map(item => request(env, `/api/v2/products/${encodeURIComponent(item.id)}`, {}, fetcher)));
    for (const result of details) {
      const product = result.data;
      if (!isObject(product) || typeof product.id !== 'string' || typeof product.title !== 'string' || !Array.isArray(product.variants)) throw invalid();
      for (const variant of product.variants) {
        if (typeof variant?.id !== 'string' || !variant.id || typeof variant.title !== 'string' || !isObject(variant.prices)) throw invalid();
        const prices = Object.fromEntries(Object.entries(variant.prices).map(([currency, price]) => [currency.toLowerCase(), price]));
        const currency = amount(prices.usd) ? 'usd' : amount(prices.vnd) ? 'vnd' : null;
        if (!currency) continue;
        products.push({
          id: productKey(product.id, variant.id, currency), productId: product.id, variantId: variant.id,
          name: `${product.title} · ${variant.title}`, price: prices[currency], currency: currency.toUpperCase(),
          stock: product.in_stock === false || variant.in_stock === false ? 0 : Number.isSafeInteger(variant.available_quantity) && variant.available_quantity >= 0 ? variant.available_quantity : null,
          // The API exposes stock, but does not promise a delivery time.
          instant: null, activationUrl: null,
          instructions: typeof variant.delivery_instructions === 'string' ? variant.delivery_instructions : '',
        });
      }
    }
  }
  const end = offset + summaries.length;
  return {products, nextOffset: summaries.length === limit && (total === null || end < total) ? end : null, total};
}

export async function roboticQuote(env, {productId, quantity}, fetcher = fetch) {
  const selected = decodeProduct(productId);
  validateQuantity(quantity);
  const result = await request(env, `/api/v2/products/${encodeURIComponent(selected.productId)}/quote`, {
    method: 'POST', body: JSON.stringify({variant_id: selected.variantId, quantity, currency_code: selected.currency}),
  }, fetcher);
  const quote = result.data;
  if (!isObject(quote) || quote.product_id !== selected.productId || quote.variant_id !== selected.variantId || quote.currency_code !== selected.currency || quote.quantity !== quantity || quote.realtime !== true || typeof quote.can_purchase !== 'boolean' || !amount(quote.unit_price) || !amount(quote.total)) throw invalid();
  if (!quote.can_purchase || (quote.available_quantity !== null && (!Number.isSafeInteger(quote.available_quantity) || quote.available_quantity < quantity))) {
    throw new SupplierError(`В ${SHOP} недостаточно товара для этого заказа.`, 'out_of_stock', 409);
  }
  return {productId, quantity, price: quote.unit_price, total: quote.total, currency: selected.currency.toUpperCase(), stock: quote.available_quantity, canPurchase: true};
}

export async function roboticCreateOrder(env, {productId, quantity}, fetcher = fetch) {
  const selected = decodeProduct(productId);
  validateQuantity(quantity);
  const result = await request(env, '/api/v2/orders', {
    method: 'POST', body: JSON.stringify({items: [{variant_id: selected.variantId, quantity}], currency_code: selected.currency, payment_method: 'wallet'}),
  }, fetcher, true);
  const checkout = result.data;
  if (!isObject(checkout) || typeof checkout.order_id !== 'string' || !checkout.order_id || checkout.order_id.length > 300) {
    const error = invalid(); error.uncertain = true; throw error;
  }
  // Return the ID immediately, allowing the caller to persist it before any polling.
  return {supplierOrderId: checkout.order_id, status: 'processing', rawStatus: typeof checkout.status === 'string' ? checkout.status : '', quantity, texts: [], credentials: [], productId: selected.productId, variantId: selected.variantId, currency: selected.currency.toUpperCase()};
}

function deliveryRecord(record) {
  if (!isObject(record) || (record.quantity != null && record.quantity !== 1)) throw invalid();
  for (const key of ['account', 'password', 'additional_info']) if (record[key] != null && typeof record[key] !== 'string') throw invalid();
  const login = record.account || '', password = record.password || '', additionalInfo = record.additional_info || '';
  if (!login && !password && !additionalInfo) throw invalid();
  const text = [login ? `Логин: ${login}` : '', password ? `Пароль: ${password}` : '', additionalInfo ? `Дополнительные данные: ${additionalInfo}` : ''].filter(Boolean).join('\n');
  const credential = login && password
    ? {kind: 'account', login, password, twoFactor: '', note: additionalInfo, code: '', additionalInfo}
    : {kind: 'code', code: text, login: '', password: '', twoFactor: '', note: '', additionalInfo};
  return {text, credential};
}

export async function roboticOrder(env, orderId, fetcher = fetch) {
  if (typeof orderId !== 'string' || !orderId || orderId.length > 300) throw new SupplierError('Не указан номер закупки ROBOTICVN SHOP.', 'supplier_order', 400);
  const result = await request(env, `/api/v2/orders/${encodeURIComponent(orderId)}`, {}, fetcher);
  const order = result.data;
  if (!isObject(order) || order.id !== orderId || !Array.isArray(order.items) || !order.items.length || order.items.some(item => !integer(item.quantity) || typeof item.id !== 'string' || !item.id)) throw invalid();
  const quantity = order.items.reduce((sum, item) => sum + item.quantity, 0);
  if (!integer(quantity)) throw invalid();
  const base = {supplierOrderId: orderId, quantity, rawStatus: typeof order.status === 'string' ? order.status : '', paymentStatus: typeof order.payment_status === 'string' ? order.payment_status : '', items: order.items.map(item => ({id: item.id, productId: item.product_id, variantId: item.variant_id, quantity: item.quantity})), currency: typeof order.currency_code === 'string' ? order.currency_code.toUpperCase() : '', total: amount(order.total) ? order.total : null};
  const delivery = await request(env, `/api/v2/orders/${encodeURIComponent(orderId)}/delivery`, {}, fetcher);
  // Both names are documented aliases of the same data. Never concatenate them.
  const rows = Array.isArray(delivery.delivered_accounts) ? delivery.delivered_accounts : delivery.deliveredAccount;
  if (!Array.isArray(rows) || rows.length > quantity) throw invalid();
  if (rows.length < quantity) return {...base, status: 'processing', texts: [], credentials: []};
  const perItem = new Map(order.items.map(item => [item.id, 0]));
  for (const row of rows) {
    if (row?.item_id != null) {
      if (!perItem.has(row.item_id)) throw invalid();
      perItem.set(row.item_id, perItem.get(row.item_id) + 1);
    } else if (order.items.length !== 1) throw invalid();
  }
  if (order.items.length > 1 && order.items.some(item => perItem.get(item.id) !== item.quantity)) throw invalid();
  const parsed = rows.map(deliveryRecord);
  return {...base, status: 'delivered', texts: parsed.map(item => item.text), credentials: parsed.map(item => item.credential)};
}
