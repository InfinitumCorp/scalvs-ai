// Real plans and payments for SCALVS.ai, through the Infinitum revenue API
// (Stripe Checkout and the Stripe customer portal). The app never sees card
// details or any Stripe key: it sends the signed-in user's Cumulus ID access
// token to the revenue API, which returns a Checkout or portal URL to open.
//
// Older browsers may still hold a billing-org API key from the earlier
// email sign-up flow ({ orgId, apiKey, email } in the store). It is only used to
// read the plan and open the billing portal, so existing subscribers can still
// manage or cancel. New checkouts need Cumulus ID.

const DEFAULT_REVENUE_URL = 'https://infinitum-revenue.infinitumcorp.workers.dev';

/**
 * The revenue API base URL. Override with REVENUE_URL at build time
 * (scripts/build-assets.mjs writes it into <meta name="revenue-url">).
 */
export function revenueUrl(doc = globalThis.document) {
  const meta = doc?.querySelector?.('meta[name="revenue-url"]')?.getAttribute('content');
  return String(meta || DEFAULT_REVENUE_URL).replace(/\/+$/, '');
}

export const PRODUCT = 'scalvs';

/** App plan id -> revenue catalog plan id. */
export const REVENUE_PLAN = { free: 'scalvs_free', pro: 'scalvs_pro', business: 'scalvs_team', government: 'scalvs_private' };
const FROM_REVENUE = Object.fromEntries(Object.entries(REVENUE_PLAN).map(([a, r]) => [r, a]));
const PAID = new Set(['trialing', 'active', 'past_due', 'bundled']);

export class BillingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call(fetchFn, method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetchFn(`${revenueUrl()}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new BillingError(0, 'network', 'Billing is unreachable. Check your connection and try again.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new BillingError(res.status, json?.error?.code ?? 'http_error', json?.error?.message ?? `Billing request failed (${res.status}).`);
  return json;
}

/** SCALVS.ai plans people can buy themselves or after approval. Contract plans are hidden. */
export async function loadCatalog({ fetch: fetchFn = globalThis.fetch } = {}) {
  const { plans = [] } = await call(fetchFn, 'GET', '/v1/catalog');
  return plans.filter((p) => p.product === PRODUCT && p.channel !== 'contract');
}

/** True when a plan can only be held by a business (or other organisation) account. */
export const businessOnly = (plan) => Array.isArray(plan?.allowedKinds) && !plan.allowedKinds.includes('individual');

export function formatPrice(plan) {
  if (!plan) return '';
  if (!plan.priceCents) return '$0';
  const dollars = (plan.priceCents / 100).toLocaleString('en-US', { minimumFractionDigits: plan.priceCents % 100 ? 2 : 0 });
  return `$${dollars} / ${plan.perSeat ? 'seat / ' : ''}${plan.interval}${plan.trialDays ? ` · ${plan.trialDays}-day trial` : ''}`;
}

/** This user's SCALVS.ai entitlement ({ product, plan, status, seats, meters }) or null. */
export async function loadEntitlement({ token, fetch: fetchFn = globalThis.fetch }) {
  if (!token) return null;
  const ent = await call(fetchFn, 'GET', '/v1/me/entitlements', { token });
  return ent?.products?.find((x) => x.product === PRODUCT) ?? null;
}

/** The app plan id ('free' | 'pro' | 'business' | 'government') for an entitlement. Unpaid subscriptions fall back to Free. */
export function planFromEntitlement(p) {
  if (!p) return 'free';
  if (p.plan !== 'scalvs_free' && !PAID.has(p.status)) return 'free';
  return FROM_REVENUE[p.plan] ?? 'free';
}

/** Where Stripe sends people back: this app's root, which reads ?billing= on load. */
export const returnUrl = (origin) => `${origin}/`;

/**
 * Starts Stripe Checkout for a plan. Business-only plans (Team, Private Tenant) first switch the
 * signed-in account to a business account named `orgName`, and per-seat plans pass `seats`.
 * Returns the Checkout URL to open.
 */
export async function startCheckout({ token, plan, seats = 1, orgName, origin, fetch: fetchFn = globalThis.fetch }) {
  if (!token) throw new BillingError(401, 'sign_in', 'Sign in with Cumulus ID to subscribe.');
  if (!plan?.id) throw new BillingError(400, 'unknown_plan', 'That plan is not available.');
  const body = { planId: plan.id, returnUrl: returnUrl(origin) };
  if (plan.perSeat) {
    const n = Number(seats);
    if (!Number.isInteger(n) || n < 1 || n > 10000) throw new BillingError(400, 'seats', 'Enter between 1 and 10,000 seats.');
    body.quantity = n;
  }
  if (businessOnly(plan)) {
    const name = String(orgName ?? '').trim();
    if (!name) throw new BillingError(400, 'org_name_required', 'Enter your business name to continue.');
    await call(fetchFn, 'POST', '/v1/me/org', { token, body: { name, kind: 'business' } });
  }
  return (await call(fetchFn, 'POST', '/v1/subscriptions/checkout', { token, body })).url;
}

/** Stripe customer portal: change or cancel the plan, change seats, update cards, download invoices. */
export async function openPortal({ token, origin, fetch: fetchFn = globalThis.fetch }) {
  if (!token) throw new BillingError(401, 'sign_in', 'Sign in with Cumulus ID to manage billing.');
  return (await call(fetchFn, 'POST', '/v1/billing/portal', { token, body: { returnUrl: returnUrl(origin) } })).url;
}

/** 'success' | 'cancelled' | null, from the query string Stripe returns with. */
export function readReturn(search) {
  const v = new URLSearchParams(search).get('billing');
  return v === 'success' || v === 'cancelled' ? v : null;
}

/** The signed-in Cumulus ID access token, or null. */
export const cidToken = (cid = globalThis.window?.CumulusID) => cid?.token?.() || null;

/** Token for reading the plan and opening the portal: Cumulus ID, else a legacy billing-org key. */
export const billingToken = (state, cid) => cidToken(cid) || state?.billing?.apiKey || null;
