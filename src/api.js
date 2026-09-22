const ROOT = 'https://api.partner.market.yandex.ru';
export const securityHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {...securityHeaders, 'Content-Type': 'application/json; charset=utf-8'}});
export class ApiError extends Error {
  constructor(message, status = 400, uncertain = false) { super(message); this.status = status; this.uncertain = uncertain; }
}
function id(value, label = 'Номер') {
  if (!/^\d+$/.test(String(value || '')) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new ApiError(`${label}: укажите положительное целое число.`);
  return Number(value);
}
function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new ApiError('Укажите существующую дату.');
  return value;
}
async function body(req) {
  if (!req.headers.get('content-type')?.startsWith('application/json')) throw new ApiError('Ожидается JSON.');
  if (Number(req.headers.get('content-length')) > 512000) throw new ApiError('Слишком большой запрос.', 413);
  const reader = req.body?.getReader(), decoder = new TextDecoder();
  let text = '', length = 0;
  if (reader) {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 512000) { await reader.cancel(); throw new ApiError('Слишком большой запрос.', 413); }
      text += decoder.decode(value, {stream: true});
    }
    text += decoder.decode();
  }
  try { return JSON.parse(text); } catch { throw new ApiError('Некорректный JSON.'); }
}
function cursor(params, limit) {
  const query = new URLSearchParams({limit: String(limit)});
  const page = params.get('pageToken');
  if (page) { if (page.length > 4000) throw new ApiError('Некорректная страница.'); query.set('pageToken', page); }
  return query;
}
async function equalSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(v => crypto.subtle.digest('SHA-256', enc.encode(v))));
  const xx = new Uint8Array(x), yy = new Uint8Array(y); let diff = 0;
  for (let i = 0; i < xx.length; i++) diff |= xx[i] ^ yy[i];
  return diff === 0;
}
export function validateDelivery(input, order) {
  id(input?.orderId, 'Номер заказа');
  if (order.status !== 'PROCESSING') throw new ApiError('Заказ уже не ожидает отправки. Обновите список.', 409);
  if (order.delivery?.type !== 'DIGITAL') throw new ApiError('Этот заказ не является цифровым.');
  if (['CHAT', 'STEAM_GIFT'].includes(order.delivery?.digitalGoods?.type)) throw new ApiError('Для этого типа товара нужна доставка через чат или Steam, а не передача ключей.');
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100 || input.items.length !== order.items?.length) throw new ApiError('Передайте все товары заказа одним запросом.');
  const seen = new Set();
  return input.items.map((item, index) => {
    const itemId = Number(item?.id);
    const expected = order.items.find(x => x.id === itemId);
    if (!Number.isSafeInteger(itemId) || itemId < 0 || !expected || seen.has(itemId)) throw new ApiError('Некорректный или повторяющийся ID товара.');
    seen.add(itemId);
    const codes = Array.isArray(item.codes) ? item.codes.map(x => typeof x === 'string' ? x.trim() : '') : [];
    if (!codes.length || codes.length > 5000 || codes.some(x => !x) || new Set(codes).size !== codes.length) throw new ApiError(`Товар ${index + 1}: ключи не должны быть пустыми или повторяться.`);
    if (codes.length !== Number(expected.count ?? expected.quantity)) throw new ApiError(`Товар ${index + 1}: требуется ключей — ${expected.count ?? expected.quantity}, введено — ${codes.length}.`);
    const slip = typeof item.slip === 'string' ? item.slip.trim() : '';
    if (!slip || slip.length > 10000) throw new ApiError('Инструкция обязательна и должна быть не длиннее 10 000 символов.');
    const until = date(item.activate_till);
    if (until < new Date().toISOString().slice(0, 10)) throw new ApiError('Срок активации уже истёк.');
    return {id: itemId, codes, slip, activate_till: until};
  });
}
export async function handleApi(req, env, fetcher = fetch) {
  try {
    const url = new URL(req.url), p = url.searchParams, route = url.pathname;
    const settings = {businessId: env.YANDEX_BUSINESS_ID || '', campaignId: env.YANDEX_CAMPAIGN_ID || '', passwordRequired: !!env.APP_PASSWORD, demo: env.DEMO === 'true'};
    if (route === '/api/settings' && req.method === 'GET') return json(settings);
    if (env.REQUIRE_PASSWORD === 'true' && (!env.APP_PASSWORD || env.APP_PASSWORD.length < 16)) throw new ApiError('В секретах хостинга нужно задать APP_PASSWORD длиной от 16 символов.', 503);
    if (req.headers.get('x-app-request') !== 'digital-goods') throw new ApiError('Откройте сервис в браузере.', 403);
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) throw new ApiError('Запрос с другого сайта отклонён.', 403);
    // Credentials live only in the current page's memory. Never log headers or request bodies.
    let password;
    try { password = decodeURIComponent(req.headers.get('x-app-password') || ''); } catch { throw new ApiError('Некорректный пароль.', 401); }
    if (env.APP_PASSWORD && !await equalSecret(password, env.APP_PASSWORD)) throw new ApiError('Неверный пароль сервиса.', 401);
    const key = req.headers.get('x-market-key');
    if (!key || key.length > 2048) throw new ApiError('Введите API-ключ Маркета.', 401);
    const business = id(settings.businessId || req.headers.get('x-business-id'), 'ID кабинета');
    const campaign = id(settings.campaignId || req.headers.get('x-campaign-id'), 'ID магазина');
    async function market(path, data, mutation = false) {
      let response;
      try {
        response = await fetcher(ROOT + path, {method: data === undefined ? 'GET' : 'POST', headers: {'Api-Key': key, 'Content-Type': 'application/json', Accept: 'application/json'}, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(20000)});
      } catch { throw new ApiError(mutation ? 'Ответ Маркета не получен. Отправка могла пройти. Проверьте заказ или переписку перед повтором.' : 'Не удалось связаться с Маркетом. Попробуйте обновить.', 502, mutation); }
      let result;
      try {
        const text = await response.text();
        result = text ? JSON.parse(text) : {};
      } catch { if (!response.ok || response.status !== 200) result = {}; else if (mutation) throw new ApiError('Маркет вернул непонятный ответ. Проверьте результат перед повтором.', 502, true); else throw new ApiError('Не удалось прочитать ответ Маркета.', 502); }
      if (!response.ok || result.status === 'ERROR' || result.errors?.length) {
        const status = response.status === 200 ? 400 : response.status;
        let message = `Маркет отклонил запрос (HTTP ${status}). Проверьте данные и состояние заказа.`;
        if (status === 401) message = 'API-ключ недействителен или отозван.';
        if (status === 403) message = path.includes('/chat') ? 'Для переписки добавьте API-ключу право «Общение с покупателями».' : 'Для работы с заказами добавьте API-ключу право «Обработка заказов и учёт товаров».';
        if (status === 404) message = 'Заказ или чат не найден либо больше недоступен.';
        if (status === 420 || status === 429) message = 'Маркет ограничил запросы. Подождите немного и обновите данные.';
        if (mutation && status >= 500) message = 'Ошибка на стороне Маркета. Результат отправки неизвестен — проверьте его перед повтором.';
        throw new ApiError(message, status, mutation && status >= 500);
      }
      return result;
    }
    async function findOrder(orderId) {
      const result = await market(`/v1/businesses/${business}/orders?limit=50`, {campaignIds: [campaign], orderIds: [id(orderId, 'Номер заказа')]});
      const order = result.orders?.find(x => String(x.id ?? x.orderId) === String(orderId));
      if (!order || (order.campaignId && Number(order.campaignId) !== campaign)) throw new ApiError('Заказ не найден в выбранном магазине.', 404);
      return order;
    }
    if (route === '/api/config' && req.method === 'GET') {
      const token = await market('/v2/auth/token', {});
      const scopes = token.result?.apiKey?.authScopes || [];
      const all = scopes.includes('ALL_METHODS');
      return json({businessId: business, campaignId: campaign, canDeliver: all || scopes.includes('INVENTORY_AND_ORDER_PROCESSING'), canChat: all || scopes.includes('COMMUNICATION'), canReadChat: all || scopes.includes('COMMUNICATION') || scopes.includes('ALL_METHODS_READ_ONLY')});
    }
    if (['/api/orders', '/api/history'].includes(route) && req.method === 'GET') {
      const query = cursor(p, 50), filter = {campaignIds: [campaign], fake: p.get('fake') === 'true'};
      if (route === '/api/orders') filter.statuses = ['PROCESSING'];
      else if (p.get('orderId')) filter.orderIds = [id(p.get('orderId'), 'Номер заказа')];
      else {
        const from = date(p.get('from')), to = date(p.get('to'));
        const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
        if (days < 1 || days > 30) throw new ApiError('Выберите период от 1 до 30 дней включительно.');
        const exclusive = new Date(Date.parse(to) + 86400000).toISOString().slice(0, 10);
        filter.dates = {creationDateFrom: from, creationDateTo: exclusive};
        if (p.get('status')) {
          if (!['DELIVERED', 'CANCELLED', 'PROCESSING'].includes(p.get('status'))) throw new ApiError('Неизвестный статус.');
          filter.statuses = [p.get('status')];
        }
      }
      const data = await market(`/v1/businesses/${business}/orders?${query}`, filter);
      return json({orders: (data.orders || []).filter(o => o.delivery?.type === 'DIGITAL'), nextPageToken: data.paging?.nextPageToken || null});
    }
    if (route === '/api/buyer' && req.method === 'GET') {
      const order = await findOrder(p.get('orderId'));
      if (!['PROCESSING', 'DELIVERY', 'PICKUP'].includes(order.status)) return json({buyer: null, unavailable: 'Маркет не раскрывает данные покупателя для завершённого заказа.'});
      const data = await market(`/v2/campaigns/${campaign}/orders/${id(p.get('orderId'))}/buyer`);
      return json({buyer: data.result});
    }
    if (route === '/api/deliver' && req.method === 'POST') {
      const input = await body(req);
      const order = await findOrder(input.orderId);
      const items = validateDelivery(input, order);
      await market(`/v2/campaigns/${campaign}/orders/${id(input.orderId)}/deliverDigitalGoods`, {items}, true);
      return json({ok: true, message: 'Маркет принял ключи. Дождитесь статуса «Доставлен» в истории — он обновится не сразу.'});
    }
    if (route === '/api/chats' && req.method === 'GET') {
      const filter = {};
      if (p.get('orderId')) filter.contexts = [{type: 'ORDER', id: id(p.get('orderId'), 'Номер заказа')}];
      if (p.get('waiting') === 'true') filter.statuses = ['WAITING_FOR_PARTNER', 'NEW'];
      const data = await market(`/v2/businesses/${business}/chats?${cursor(p, 20)}`, filter);
      return json({chats: data.result?.chats || [], nextPageToken: data.result?.paging?.nextPageToken || null});
    }
    if (route === '/api/chat' && req.method === 'GET') {
      const chatId = id(p.get('chatId'), 'Номер чата');
      const query = cursor(p, 100); query.set('chatId', chatId);
      const [info, history] = await Promise.all([market(`/v2/businesses/${business}/chat?chatId=${chatId}`), market(`/v2/businesses/${business}/chats/history?${query}`, {})]);
      return json({chat: info.result, messages: history.result?.messages || [], nextPageToken: history.result?.paging?.nextPageToken || null});
    }
    if (route === '/api/message' && req.method === 'POST') {
      const input = await body(req), chatId = id(input?.chatId, 'Номер чата');
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      if (!message || message.length > 4096) throw new ApiError('Напишите сообщение длиной от 1 до 4096 символов.');
      const info = await market(`/v2/businesses/${business}/chat?chatId=${chatId}`);
      if (info.result?.status === 'FINISHED') throw new ApiError('Чат завершён. Отправка недоступна.', 409);
      await market(`/v2/businesses/${business}/chats/message?chatId=${chatId}`, {message}, true);
      return json({ok: true});
    }
    throw new ApiError('Метод не найден.', 404);
  } catch (error) {
    return json({error: error instanceof ApiError ? error.message : 'Не удалось обработать запрос.', uncertain: !!error.uncertain}, error instanceof ApiError ? error.status : 500);
  }
}
