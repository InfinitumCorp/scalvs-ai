// x402: AI agents pay per API request; people on scalvs.app stay free; inert without X402_PAY_TO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { x402FromEnv, usdToAtomic, isPersonRequest, withX402, USDC_BASE, BASE_MAINNET, DEFAULT_FACILITATOR } from '../api/_x402.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const ON = { X402_PAY_TO: WALLET };
const decode = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64');
const ok = () => new Response(JSON.stringify({ done: true }), { status: 200, headers: { 'content-type': 'application/json' } });
const agent = (headers = {}) => new Request('https://scalvs.app/api/run', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
const facilitator = (verify, settle, calls = []) => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
  return new Response(JSON.stringify(url.endsWith('/verify') ? verify : settle), { status: 200 });
};

test('off without a valid X402_PAY_TO, with X402=off, or with a bad price', () => {
  assert.equal(x402FromEnv({}), null);
  assert.equal(x402FromEnv({ X402_PAY_TO: 'not-a-wallet' }), null);
  assert.equal(x402FromEnv({ ...ON, X402: 'off' }), null);
  assert.equal(x402FromEnv({ ...ON, X402: 'OFF' }), null);
  assert.equal(x402FromEnv({ ...ON, X402_PRICE_USD: '0' }), null);
  assert.equal(x402FromEnv({ ...ON, X402_PRICE_USD: 'abc' }), null);
});

test('defaults: $0.001 in USDC on Base mainnet via the x402.org facilitator', () => {
  const c = x402FromEnv(ON);
  assert.equal(c.amount, '1000');
  assert.equal(c.network, BASE_MAINNET);
  assert.equal(c.asset, USDC_BASE);
  assert.equal(c.payTo, WALLET);
  assert.equal(c.facilitator, DEFAULT_FACILITATOR);
  assert.equal(usdToAtomic('0.01'), '10000');
  assert.equal(usdToAtomic('0.0000001'), null);
});

test('browser, desktop and phone requests count as people; bare scripts do not', () => {
  assert.equal(isPersonRequest(agent({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' })), true);
  assert.equal(isPersonRequest(agent({ 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' })), true);
  assert.equal(isPersonRequest(agent({ origin: 'https://scalvs.app' })), true);
  assert.equal(isPersonRequest(agent()), false);
  assert.equal(isPersonRequest(agent({ 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(isPersonRequest(agent({ origin: 'https://evil.example' })), false);
});

test('inert without a wallet: agents pass straight through, no facilitator call', async () => {
  let called = false;
  const res = await withX402(agent(), {}, ok, { fetch: async () => { called = true; } });
  assert.equal(res.status, 200);
  assert.equal(called, false);
});

test('people are never charged even when x402 is on', async () => {
  let called = false;
  const res = await withX402(agent({ 'sec-fetch-site': 'same-origin' }), ON, ok, { fetch: async () => { called = true; } });
  assert.equal(res.status, 200);
  assert.equal(called, false);
});

test('an agent without payment gets 402 with a PAYMENT-REQUIRED header (x402 v2) and nothing runs', async () => {
  let ran = false;
  const res = await withX402(agent(), ON, () => { ran = true; return ok(); });
  assert.equal(res.status, 402);
  assert.equal(ran, false);
  const req = decode(res.headers.get('PAYMENT-REQUIRED'));
  assert.equal(req.x402Version, 2);
  assert.equal(req.accepts.length, 1);
  assert.deepEqual(
    { scheme: req.accepts[0].scheme, network: req.accepts[0].network, amount: req.accepts[0].amount, asset: req.accepts[0].asset, payTo: req.accepts[0].payTo },
    { scheme: 'exact', network: 'eip155:8453', amount: '1000', asset: USDC_BASE, payTo: WALLET },
  );
  assert.deepEqual(await res.json(), req);
  assert.match(res.headers.get('access-control-expose-headers'), /PAYMENT-REQUIRED/);
});

test('a valid payment is verified, the call runs, then it is settled and PAYMENT-RESPONSE returned', async () => {
  const calls = [];
  const settle = { success: true, transaction: '0xabc', network: 'eip155:8453', payer: '0x2222222222222222222222222222222222222222' };
  const payload = { x402Version: 2, accepted: { scheme: 'exact' }, payload: { signature: '0xsig' } };
  const res = await withX402(agent({ 'PAYMENT-SIGNATURE': encode(payload) }), { ...ON, X402_FACILITATOR_API_KEY: 'k' }, ok, { fetch: facilitator({ isValid: true }, settle, calls) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { done: true });
  assert.deepEqual(decode(res.headers.get('PAYMENT-RESPONSE')), settle);
  assert.deepEqual(calls.map((c) => c.url), [`${DEFAULT_FACILITATOR}/verify`, `${DEFAULT_FACILITATOR}/settle`]);
  assert.deepEqual(calls[0].body.paymentPayload, payload);
  assert.equal(calls[0].body.paymentRequirements.payTo, WALLET);
  assert.equal(calls[0].headers.authorization, 'Bearer k');
});

test('invalid, unreadable or unverifiable payments get 402 and the call never runs', async () => {
  let ran = false;
  const run = () => { ran = true; return ok(); };
  const bad = await withX402(agent({ 'PAYMENT-SIGNATURE': encode({}) }), ON, run, { fetch: facilitator({ isValid: false, invalidReason: 'insufficient_funds' }, {}) });
  assert.equal(bad.status, 402);
  assert.equal(decode(bad.headers.get('PAYMENT-REQUIRED')).error, 'insufficient_funds');
  const junk = await withX402(agent({ 'PAYMENT-SIGNATURE': '%%%' }), ON, run, { fetch: facilitator({ isValid: true }, {}) });
  assert.equal(junk.status, 402);
  const down = await withX402(agent({ 'PAYMENT-SIGNATURE': encode({}) }), ON, run, { fetch: async () => new Response('', { status: 503 }) });
  assert.equal(down.status, 402);
  assert.equal(decode(down.headers.get('PAYMENT-REQUIRED')).error, 'facilitator_unavailable');
  assert.equal(ran, false);
});

test('failed calls are not settled', async () => {
  const calls = [];
  const res = await withX402(agent({ 'PAYMENT-SIGNATURE': encode({}) }), ON, () => new Response('nope', { status: 500 }), { fetch: facilitator({ isValid: true }, { success: true }, calls) });
  assert.equal(res.status, 500);
  assert.deepEqual(calls.map((c) => c.url.split('/').pop()), ['verify']);
});

test('the legacy X-PAYMENT header is accepted too', async () => {
  const res = await withX402(agent({ 'X-PAYMENT': encode({}) }), ON, ok, { fetch: facilitator({ isValid: true }, { success: true }) });
  assert.equal(res.status, 200);
});

test('worker: agents are asked to pay on /api/*; the site, people and x402-off are unchanged', async () => {
  const env = (extra = {}) => ({ AI: { run: async () => ({ image: 'aGVsbG8=' }) }, ASSETS: { fetch: () => new Response('<html>site</html>') }, ...extra });
  const imagine = (headers = {}) => new Request('https://scalvs.app/api/imagine', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ prompt: 'a lighthouse' }) });
  const ctx = { waitUntil() {} };
  const paid = await worker.fetch(imagine(), env(ON), ctx);
  assert.equal(paid.status, 402);
  assert.equal(paid.headers.get('x-content-type-options'), 'nosniff');
  const person = await worker.fetch(imagine({ 'sec-fetch-site': 'same-origin' }), env(ON), ctx);
  assert.notEqual(person.status, 402);
  const off = await worker.fetch(imagine(), env({ ...ON, X402: 'off' }), ctx);
  assert.notEqual(off.status, 402);
  const unset = await worker.fetch(imagine(), env(), ctx);
  assert.notEqual(unset.status, 402);
  const page = await worker.fetch(new Request('https://scalvs.app/'), env(ON), ctx);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '<html>site</html>');
});
