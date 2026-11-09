// Real plans and payments for SCALVS.ai, through the Infinitum revenue API
// (Stripe Checkout and the Stripe customer portal). The app never sees card
// details or Stripe keys: it holds this browser's billing-org API key, which
// only manages that org's own subscription.

export const REVENUE_URL = 'https://infinitum-revenue.infinitumcorp.workers.dev';

/** App plan id -> revenue catalog plan id. Government is sold by contract. */
export const REVENUE_PLAN = { pro: 'scalvs_pro', business: 'scalvs_team' };
const FROM_REVENUE = { scalvs_free: 'free', scalvs_pro: 'pro', scalvs_team: 'business', scalvs_private: 'government' };
const PAID = new Set(['trialing', 'active', 'past_due', 'bundled']);

export class BillingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call(fetchFn, method, path, { key, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers.authorization = `Bearer ${key}`;
  let res;
  try {
    res = await fetchFn(`${REVENUE_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new BillingError(0, 'network', 'Billing is unreachable. Check your connection and try again.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new BillingError(res.status, json?.error?.code ?? 'http_error', json?.error?.message ?? 'Billing request failed.');
  return json;
}

export const validEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email ?? '').trim());

/** The SCALVS.ai plan this org is on, from revenue entitlements. Unpaid subscriptions fall back to Free. */
export function planFromEntitlements(ent) {
  const p = ent?.products?.find((x) => x.product === 'scalvs');
  if (!p) return 'free';
  if (p.plan !== 'scalvs_free' && !PAID.has(p.status)) return 'free';
  return FROM_REVENUE[p.plan] ?? 'free';
}

/** Where Stripe sends people back: this app's root, which reads ?billing= on load. */
export const returnUrl = (origin) => `${origin}/`;

/**
 * Starts Stripe Checkout for a paid plan. Creates the billing org on first use.
 * Returns the (possibly new) billing record to persist and the Checkout URL to open.
 */
export async function startUpgrade({ billing, planId, email, origin, fetch: fetchFn = globalThis.fetch }) {
  const target = REVENUE_PLAN[planId];
  if (!target) throw new BillingError(400, 'contact_sales', 'Government plans are sold by contract. Contact Infinitum sales.');
  let b = billing;
  if (!b?.apiKey) {
    if (!validEmail(email)) throw new BillingError(400, 'email_required', 'Enter a billing email to continue.');
    const clean = email.trim();
    const org = await call(fetchFn, 'POST', '/v1/signup', {
      body: { name: clean, email: clean, kind: planId === 'business' ? 'business' : 'individual' },
    });
    b = { orgId: org.orgId, apiKey: org.apiKey, email: clean };
  }
  const session = await call(fetchFn, 'POST', '/v1/subscriptions/checkout', {
    key: b.apiKey, body: { planId: target, returnUrl: returnUrl(origin) },
  });
  return { billing: b, url: session.url };
}

/** Stripe customer portal: change or cancel the plan, update cards, download invoices. */
export async function openPortal({ billing, origin, fetch: fetchFn = globalThis.fetch }) {
  if (!billing?.apiKey) throw new BillingError(400, 'no_account', 'No billing account yet.');
  return (await call(fetchFn, 'POST', '/v1/billing/portal', { key: billing.apiKey, body: { returnUrl: returnUrl(origin) } })).url;
}

/** Current plan from the revenue API. */
export async function syncPlan({ billing, fetch: fetchFn = globalThis.fetch }) {
  if (!billing?.apiKey) return 'free';
  return planFromEntitlements(await call(fetchFn, 'GET', '/v1/me/entitlements', { key: billing.apiKey }));
}

/** 'success' | 'cancelled' | null, from the query string Stripe returns with. */
export function readReturn(search) {
  const v = new URLSearchParams(search).get('billing');
  return v === 'success' || v === 'cancelled' ? v : null;
}
