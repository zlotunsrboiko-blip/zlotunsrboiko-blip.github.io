import test from 'node:test';
import assert from 'node:assert/strict';
import {roboticAccount, roboticProducts, roboticQuote, roboticCreateOrder, roboticOrder} from '../src/roboticvn.js';

const env = {ROBOTICVN_API_KEY: 'test-key'};
const selected = 'rvn:prod%3Aone:variant%3Aone:usd';
const product = {id: 'prod:one', title: 'Product', in_stock: true, variants: [{id: 'variant:one', title: 'Monthly', prices: {usd: 2.5, vnd: 65000}, in_stock: true, available_quantity: 8, delivery_instructions: 'Use the account.'}]};
const order = {id: 'order_1', status: 'completed', payment_status: 'captured', total: 2.5, currency_code: 'usd', items: [{id: 'item_1', product_id: 'prod:one', variant_id: 'variant:one', quantity: 1}]};

test('ROBOTICVN account keeps currencies separate and sends key only in its API header', async () => {
  const result = await roboticAccount(env, async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.roboticvn.com');
    assert.equal(parsed.searchParams.get('locale'), 'en-US');
    assert.equal(options.headers['x-api-key'], 'test-key');
    assert.ok(!url.includes('test-key'));
    return Response.json({data: parsed.pathname.endsWith('/me') ? {first_name: 'Test', last_name: 'User'} : {vnd: 500000, usd: 25}});
  });
  assert.equal(result.balance, 25);
  assert.equal(result.currency, 'USD');
  assert.deepEqual(result.balances, [{balance: 500000, currency: 'VND'}, {balance: 25, currency: 'USD'}]);
});

test('ROBOTICVN catalog uses selectable variant IDs and a real wallet currency', async () => {
  const result = await roboticProducts(env, async url => Response.json({data: new URL(url).pathname === '/api/v2/products' ? [{id: product.id, title: product.title}] : product}));
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].id, selected);
  assert.equal(result.products[0].price, 2.5);
  assert.equal(result.products[0].currency, 'USD');
  assert.equal(result.products[0].stock, 8);
  assert.equal(result.products[0].instant, null);
  assert.equal(result.nextOffset, null);
});

test('ROBOTICVN catalog stays within one bounded page of detail requests', async () => {
  let calls = 0;
  const result = await roboticProducts(env, async url => {
    calls++;
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v2/products') {
      assert.equal(parsed.searchParams.get('limit'), '15');
      assert.equal(parsed.searchParams.get('offset'), '15');
      return Response.json({data: Array.from({length: 15}, (_, i) => ({id: `prod_${i}`})), meta: {count: 59, limit: 15, offset: 15}});
    }
    return Response.json({data: {...product, id: parsed.pathname.split('/').at(-1)}});
  }, {offset: 15});
  assert.equal(calls, 16);
  assert.equal(result.products.length, 15);
  assert.equal(result.nextOffset, 30);
  assert.equal(result.total, 59);
});

test('ROBOTICVN quote checks the exact variant, count, live stock and currency', async () => {
  const result = await roboticQuote(env, {productId: selected, quantity: 2}, async (url, options) => {
    assert.equal(new URL(url).pathname, '/api/v2/products/prod%3Aone/quote');
    assert.deepEqual(JSON.parse(options.body), {variant_id: 'variant:one', quantity: 2, currency_code: 'usd'});
    return Response.json({data: {product_id: 'prod:one', variant_id: 'variant:one', quantity: 2, currency_code: 'usd', unit_price: 2.5, total: 5, available_quantity: 8, can_purchase: true, realtime: true}});
  });
  assert.equal(result.total, 5);
  await assert.rejects(roboticQuote(env, {productId: selected, quantity: 2}, async () => Response.json({data: {product_id: 'prod:one', variant_id: 'different', quantity: 2, currency_code: 'usd', unit_price: 2.5, total: 5, available_quantity: 8, can_purchase: true, realtime: true}})), {code: 'supplier_response'});
});

test('ROBOTICVN checkout charges wallet once and returns the ID before polling', async () => {
  let calls = 0;
  const result = await roboticCreateOrder(env, {productId: selected, quantity: 1}, async (url, options) => {
    calls++;
    assert.equal(new URL(url).pathname, '/api/v2/orders');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), {items: [{variant_id: 'variant:one', quantity: 1}], currency_code: 'usd', payment_method: 'wallet'});
    assert.equal(Object.hasOwn(options.headers, 'Idempotency-Key'), false);
    return Response.json({data: {order_id: 'order_1', status: 'completed'}}, {status: 201});
  });
  assert.equal(calls, 1);
  assert.equal(result.supplierOrderId, 'order_1');
  assert.equal(result.status, 'processing');
});

test('ROBOTICVN uncertain purchases are never retried and upstream secrets stay hidden', async () => {
  const failures = [
    async () => {throw new Error('sensitive network details');},
    async () => Response.json({error: {code: 'oops', message: 'SECRET'}}, {status: 500}),
    async () => new Response('<html>SECRET</html>', {status: 200}),
    async () => Response.json({data: {checkout_id: 'missing-order-id'}}, {status: 201}),
  ];
  for (const failure of failures) {
    let calls = 0;
    await assert.rejects(roboticCreateOrder(env, {productId: selected, quantity: 1}, async (...args) => {calls++; return failure(...args);}), error => {
      assert.equal(error.uncertain, true);
      assert.ok(!error.message.includes('SECRET'));
      assert.ok(!error.message.includes('sensitive'));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('ROBOTICVN explicit declined checkout is sanitized and distinguishable from uncertainty', async () => {
  await assert.rejects(roboticCreateOrder(env, {productId: selected, quantity: 1}, async () => Response.json({error: {code: 'insufficient_balance', message: 'SECRET'}}, {status: 400})), error => {
    assert.equal(error.code, 'insufficient_balance');
    assert.notEqual(error.uncertain, true);
    assert.ok(!error.message.includes('SECRET'));
    return true;
  });
});

test('ROBOTICVN delivery preserves multiline supplementary data and does not duplicate aliases', async () => {
  const record = {item_id: 'item_1', quantity: 1, account: 'test@example.invalid', password: ' password | with spaces ', additional_info: '2FA: ABC\nRecovery: https://example.invalid/a|b\nTrailing text'};
  const result = await roboticOrder(env, 'order_1', async url => Response.json(new URL(url).pathname.endsWith('/delivery') ? {deliveredAccount: [record], delivered_accounts: [record]} : {data: order}));
  assert.equal(result.status, 'delivered');
  assert.equal(result.quantity, 1);
  assert.equal(result.texts.length, 1);
  assert.ok(result.texts[0].includes(record.password));
  assert.ok(result.texts[0].endsWith(record.additional_info));
  assert.equal(result.credentials[0].login, record.account);
  assert.equal(result.credentials[0].password, record.password);
  assert.equal(result.credentials[0].additionalInfo, record.additional_info);
});

test('ROBOTICVN pending credentials are polled without guessing undocumented statuses', async () => {
  const result = await roboticOrder(env, 'order_1', async url => Response.json(new URL(url).pathname.endsWith('/delivery') ? {deliveredAccount: [], delivered_accounts: []} : {data: {...order, status: 'some_future_status'}}));
  assert.equal(result.status, 'processing');
  assert.deepEqual(result.texts, []);
});

test('ROBOTICVN rejects grouped, empty or mismatched delivery data', async () => {
  for (const record of [{item_id: 'another_item', account: 'a', password: 'b'}, {item_id: 'item_1', quantity: 2, account: 'a', password: 'b'}, {item_id: 'item_1', account: null, password: null}]) {
    await assert.rejects(roboticOrder(env, 'order_1', async url => Response.json(new URL(url).pathname.endsWith('/delivery') ? {delivered_accounts: [record]} : {data: order})), {code: 'supplier_response'});
  }
});

test('ROBOTICVN validates purchase inputs before network access', async () => {
  let calls = 0;
  const fetcher = async () => {calls++; return Response.json({});};
  await assert.rejects(roboticCreateOrder(env, {productId: '123', quantity: 1}, fetcher), {code: 'supplier_product'});
  await assert.rejects(roboticCreateOrder(env, {productId: selected, quantity: 0}, fetcher), {code: 'supplier_quantity'});
  await assert.rejects(roboticCreateOrder({}, {productId: selected, quantity: 1}, fetcher), {code: 'supplier_not_configured'});
  assert.equal(calls, 0);
});
