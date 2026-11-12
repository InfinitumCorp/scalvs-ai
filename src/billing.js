// Real plans and payments for SCALVS.ai, through the Infinitum revenue API
// (Stripe Checkout and the Stripe customer portal). The app never holds a Stripe
// key and never sees card details: it sends the signed-in user's Cumulus ID access
// token to the revenue API, which returns a Checkout or portal URL to open.

import { REVENUE_URL as CONFIGURED_URL } from './config.js';

export const REVENUE_URL = String(CONFIGURED_URL || 'https://infinitum-revenue.infinitumcorp.workers.dev').replace(/\/+$/, '');
export const PRODUCT = 'scalvs';

/** Revenue catalog plan id -> this app's plan id (src/data.js PLANS). */
export const FROM_REVENUE = { scalvs_free: 'free', scalvs_pro: 'pro', scalvs_team: 'business', scalvs_private: 'government' };
const PAID = new Set(['trialing', 'active', 'past_due', 'bundled']);

export class BillingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The signed-in user's Cumulus ID access token (public/cumulus-id.js), or null. */
export const cidToken = () => (typeof window !== 'undefined' && window.CumulusID?.token?.()) || null;

async function call(fetchFn, method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetchFn(`${REVENUE_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new BillingError(0, 'network', 'Billing is unreachable. Check your connection and try again.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new BillingError(res.status, json?.error?.code ?? 'http_error', json?.error?.message ?? `Billing request failed (${res.status}).`);
  return json;
}

const needToken = (token) => {
  if (!token) throw new BillingError(401, 'signed_out', 'Sign in with Cumulus ID to manage your plan.');
  return token;
};

/** True for plans an individual account can't buy (Team): the account must switch to business first. */
export const businessOnly = (plan) => Array.isArray(plan?.allowedKinds) && !plan.allowedKinds.includes('individual');

/** "$29 / month", "$49 / month per seat", "Free". */
export function formatPrice(plan) {
  if (!plan?.priceCents) return 'Free';
  const n = (plan.priceCents / 100).toLocaleString('en-US', { minimumFractionDigits: plan.priceCents % 100 ? 2 : 0 });
  return `$${n} / ${plan.interval || 'month'}${plan.perSeat ? ' per seat' : ''}`;
}

/** SCALVS.ai plans from the public catalog, cheapest first. Contract-only plans are left out. */
export async function loadCatalog({ fetch: fetchFn = globalThis.fetch } = {}) {
  const { plans = [] } = await call(fetchFn, 'GET', '/v1/catalog');
  return plans.filter((p) => p.product === PRODUCT && p.channel !== 'contract').sort((a, b) => a.priceCents - b.priceCents);
}

/** This user's SCALVS.ai entitlement ({ plan, status, seats, ... }) or null. */
export async function loadEntitlement({ token = cidToken(), fetch: fetchFn = globalThis.fetch } = {}) {
  const ent = await call(fetchFn, 'GET', '/v1/me/entitlements', { token: needToken(token) });
  return ent?.products?.find((x) => x.product === PRODUCT) ?? null;
}

/** The app plan id ('free' | 'pro' | 'business' | 'government') for an entitlement. Unpaid subscriptions fall back to Free. */
export function planFromEntitlement(p) {
  if (!p) return 'free';
  if (p.plan !== 'scalvs_free' && !PAID.has(p.status)) return 'free';
  return FROM_REVENUE[p.plan] ?? 'free';
}

/** Where Stripe and the portal send people back: this app's root, which reads ?billing= on load. */
export const returnUrl = (origin) => `${origin}/`;

/** Switches the signed-in user's billing account to a business (needed for Team). */
export async function switchToBusiness({ name, token = cidToken(), fetch: fetchFn = globalThis.fetch }) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new BillingError(400, 'name_required', 'Enter your business name to continue.');
  return call(fetchFn, 'POST', '/v1/me/org', { token: needToken(token), body: { name: clean.slice(0, 200), kind: 'business' } });
}

/** Starts Stripe Checkout for a catalog plan. Returns the Checkout URL to open. */
export async function startCheckout({ planId, quantity, origin, token = cidToken(), fetch: fetchFn = globalThis.fetch }) {
  const body = { planId, returnUrl: returnUrl(origin) };
  if (quantity && quantity > 1) body.quantity = Math.min(10000, Math.floor(quantity));
  return (await call(fetchFn, 'POST', '/v1/subscriptions/checkout', { token: needToken(token), body })).url;
}

/** Stripe customer portal: change or cancel the plan, update cards, download invoices. */
export async function openPortal({ origin, token = cidToken(), fetch: fetchFn = globalThis.fetch }) {
  return (await call(fetchFn, 'POST', '/v1/billing/portal', { token: needToken(token), body: { returnUrl: returnUrl(origin) } })).url;
}

/** 'success' | 'cancelled' | null, from the query string Stripe returns with. */
export function readReturn(search) {
  const v = new URLSearchParams(search).get('billing');
  return v === 'success' || v === 'cancelled' ? v : null;
}
