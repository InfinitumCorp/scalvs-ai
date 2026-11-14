import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REVENUE_URL, loadCatalog, loadEntitlement, planFromEntitlement, startCheckout, openPortal, switchToBusiness,
  businessOnly, formatPrice, readReturn, BillingError,
} from '../src/billing.js';
import { browserConfig, cleanUrl } from '../scripts/browser-config.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function recorder(reply) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    return reply(url, init);
  };
  return { calls, fetch };
}

const CATALOG = {
  plans: [
    { id: 'scalvs_team', product: 'scalvs', name: 'SCALVS.ai Team', channel: 'self_serve', priceCents: 4900, interval: 'month', perSeat: true, allowedKinds: ['business', 'government'] },
    { id: 'scalvs_free', product: 'scalvs', name: 'SCALVS.ai Free', channel: 'self_serve', priceCents: 0, interval: 'month', allowedKinds: ['individual', 'business', 'government'] },
    { id: 'scalvs_pro', product: 'scalvs', name: 'SCALVS.ai Pro', channel: 'self_serve', priceCents: 2900, interval: 'month', trialDays: 14, allowedKinds: ['individual', 'business', 'government'] },
    { id: 'cndctr_pro', product: 'cndctr', name: 'Other product', channel: 'self_serve', priceCents: 3900, interval: 'month' },
    { id: 'scalvs_contract', product: 'scalvs', name: 'Contract', channel: 'contract', priceCents: 0, interval: 'month' },
  ],
};

test('catalog keeps only SCALVS.ai self-serve and sales plans, cheapest first, without a token', async () => {
  const { calls, fetch } = recorder(() => json(CATALOG));
  const plans = await loadCatalog({ fetch });
  assert.deepEqual(plans.map((p) => p.id), ['scalvs_free', 'scalvs_pro', 'scalvs_team']);
  assert.equal(calls[0].url, `${REVENUE_URL}/v1/catalog`);
  assert.equal(calls[0].headers.authorization, undefined);
});

test('entitlements send the Cumulus ID token and pick the scalvs product', async () => {
  const { calls, fetch } = recorder(() => json({ products: [{ product: 'cndctr', plan: 'cndctr_pro', status: 'active' }, { product: 'scalvs', plan: 'scalvs_pro', status: 'trialing', seats: 1 }] }));
  const ent = await loadEntitlement({ token: 'cid-token', fetch });
  assert.equal(calls[0].headers.authorization, 'Bearer cid-token');
  assert.equal(ent.plan, 'scalvs_pro');
  assert.equal(planFromEntitlement(ent), 'pro');
});

test('unpaid or missing subscriptions count as Free', () => {
  assert.equal(planFromEntitlement(null), 'free');
  assert.equal(planFromEntitlement({ plan: 'scalvs_team', status: 'canceled' }), 'free');
  assert.equal(planFromEntitlement({ plan: 'scalvs_team', status: 'active' }), 'business');
});

test('signed out: billing calls fail without touching the network', async () => {
  const { calls, fetch } = recorder(() => json({}));
  await assert.rejects(startCheckout({ planId: 'scalvs_pro', origin: 'https://scalvs.app', token: null, fetch }), (e) => e instanceof BillingError && e.code === 'signed_out');
  await assert.rejects(openPortal({ origin: 'https://scalvs.app', token: null, fetch }), /Sign in with Cumulus ID/);
  assert.equal(calls.length, 0);
});

test('checkout posts the plan, seats and return URL and returns the Stripe URL', async () => {
  const { calls, fetch } = recorder(() => json({ url: 'https://checkout.stripe.com/c/x' }));
  const url = await startCheckout({ planId: 'scalvs_team', quantity: 3, origin: 'https://scalvs.app', token: 't', fetch });
  assert.equal(url, 'https://checkout.stripe.com/c/x');
  assert.equal(calls[0].url, `${REVENUE_URL}/v1/subscriptions/checkout`);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { planId: 'scalvs_team', quantity: 3, returnUrl: 'https://scalvs.app/' });
});

test('portal returns the Stripe portal URL', async () => {
  const { calls, fetch } = recorder(() => json({ url: 'https://billing.stripe.com/p/x' }));
  assert.equal(await openPortal({ origin: 'https://scalvs.app', token: 't', fetch }), 'https://billing.stripe.com/p/x');
  assert.deepEqual(calls[0].body, { returnUrl: 'https://scalvs.app/' });
});

test('Team is business-only; switching to business posts /v1/me/org', async () => {
  const plans = CATALOG.plans;
  assert.equal(businessOnly(plans.find((p) => p.id === 'scalvs_team')), true);
  assert.equal(businessOnly(plans.find((p) => p.id === 'scalvs_pro')), false);
  const { calls, fetch } = recorder(() => json({ id: 'org_1', name: 'Acme', kind: 'business' }));
  await assert.rejects(switchToBusiness({ name: '  ', token: 't', fetch }), (e) => e.code === 'name_required');
  await switchToBusiness({ name: ' Acme ', token: 't', fetch });
  assert.equal(calls[0].url, `${REVENUE_URL}/v1/me/org`);
  assert.deepEqual(calls[0].body, { name: 'Acme', kind: 'business' });
});

test('API errors surface the revenue message and code', async () => {
  const { fetch } = recorder(() => json({ error: { code: 'plan_not_allowed', message: 'This plan is for businesses' } }, 403));
  await assert.rejects(startCheckout({ planId: 'scalvs_team', origin: 'https://scalvs.app', token: 't', fetch }), (e) => e.status === 403 && e.code === 'plan_not_allowed' && /businesses/.test(e.message));
});

test('prices and Stripe return flags', () => {
  assert.equal(formatPrice({ priceCents: 0 }), 'Free');
  assert.equal(formatPrice({ priceCents: 2900, interval: 'month' }), '$29 / month');
  assert.equal(formatPrice({ priceCents: 4900, interval: 'month', perSeat: true }), '$49 / month per seat');
  assert.equal(readReturn('?billing=success'), 'success');
  assert.equal(readReturn('?billing=cancelled'), 'cancelled');
  assert.equal(readReturn('?billing=evil'), null);
});

test('REVENUE_URL comes from the environment at build time, safely', () => {
  assert.match(browserConfig({}), /export const REVENUE_URL = "https:\/\/infinitum-revenue\.infinitumcorp\.workers\.dev";/);
  assert.match(browserConfig({ REVENUE_URL: 'https://billing.example.com/' }), /"https:\/\/billing\.example\.com"/);
  assert.equal(cleanUrl('javascript:alert(1)', 'd'), 'd');
  assert.equal(cleanUrl('http://evil.example', 'd'), 'd');
  assert.equal(cleanUrl('http://localhost:8787', 'd'), 'http://localhost:8787');
  assert.equal(cleanUrl('https://x.example/";alert(1)//', 'd').includes('"'), false);
});
