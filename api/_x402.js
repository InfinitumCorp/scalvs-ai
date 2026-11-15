// x402 (HTTP 402 micropayments) for AI agents and scripts calling the SCALVS API.
// People using scalvs.app (browser, desktop and phone shells) are never charged and
// never see a 402: only requests that carry none of a browser's same-site signals are
// asked to pay. Spec: x402 v2, https://github.com/x402-foundation/x402 (HTTP transport:
// PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE headers, base64 JSON).
//
// On by default in code, but inert until X402_PAY_TO holds a receiving wallet address.
//   X402_PAY_TO            0x… address that receives USDC (unset: x402 is off)
//   X402=off               turn it off even when X402_PAY_TO is set
//   X402_PRICE_USD         price per request in USD (default 0.001)
//   X402_NETWORK           CAIP-2 network (default eip155:8453, Base mainnet)
//   X402_ASSET             token contract (default USDC on Base)
//   X402_FACILITATOR_URL   facilitator with /verify and /settle (default https://x402.org/facilitator)
//   X402_FACILITATOR_API_KEY  optional secret, sent as a Bearer token to the facilitator
//
// The browser signals (Sec-Fetch-*, Origin) can be imitated, so this is a toll for honest
// agents, not access control. The per-IP rate limit in worker.js still applies to everyone.

export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const BASE_MAINNET = 'eip155:8453';
export const DEFAULT_FACILITATOR = 'https://x402.org/facilitator';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EXPOSE = 'PAYMENT-REQUIRED, PAYMENT-RESPONSE';

const b64encode = (value) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64decode = (text) => {
  const bin = atob(String(text).trim());
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
};

/** USD price -> USDC atomic units (6 decimals), as a string. Invalid or non-positive: null. */
export function usdToAtomic(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return null;
  const units = Math.round(n * 1e6);
  return units > 0 ? String(units) : null;
}

/** Config from env, or null when x402 is off (switch off, or no valid wallet address). */
export function x402FromEnv(env = {}) {
  if (String(env.X402 ?? '').toLowerCase() === 'off') return null;
  const payTo = String(env.X402_PAY_TO ?? '').trim();
  if (!ADDRESS.test(payTo)) return null;
  const amount = usdToAtomic(env.X402_PRICE_USD ?? '0.001');
  if (!amount) return null;
  return {
    payTo,
    amount,
    priceUsd: Number(env.X402_PRICE_USD ?? '0.001'),
    network: String(env.X402_NETWORK || BASE_MAINNET),
    asset: String(env.X402_ASSET || USDC_BASE),
    facilitator: String(env.X402_FACILITATOR_URL || DEFAULT_FACILITATOR).replace(/\/+$/, ''),
    facilitatorKey: env.X402_FACILITATOR_API_KEY || '',
  };
}

/**
 * True when the request looks like a person on scalvs.app: a same-site fetch or a page
 * navigation from a browser (the site, the desktop window and the phone apps all load
 * https://scalvs.app). Scripts, SDKs and agent frameworks send none of these.
 */
export function isPersonRequest(request) {
  const h = request.headers;
  const site = (h.get('sec-fetch-site') || '').toLowerCase();
  const mode = (h.get('sec-fetch-mode') || '').toLowerCase();
  if (site === 'same-origin' || site === 'same-site') return true;
  if (mode === 'navigate') return true;
  const origin = h.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host === new URL(request.url).host) return true;
    } catch { /* not a URL: treat as no origin */ }
  }
  return false;
}

export function paymentRequirements(config, request, description = 'SCALVS.ai API request') {
  return {
    scheme: 'exact',
    network: config.network,
    amount: config.amount,
    asset: config.asset,
    payTo: config.payTo,
    maxTimeoutSeconds: 60,
    extra: { name: 'USD Coin', version: '2' },
    resource: request.url,
    description,
    mimeType: 'application/json',
  };
}

export function paymentRequired(config, request, error) {
  const accepts = [paymentRequirements(config, request)];
  return {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: { url: request.url, description: 'SCALVS.ai API request', mimeType: 'application/json' },
    accepts,
  };
}

function challenge(config, request, error, baseHeaders = {}) {
  const body = paymentRequired(config, request, error);
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      ...baseHeaders,
      'content-type': 'application/json',
      'PAYMENT-REQUIRED': b64encode(body),
      'Access-Control-Expose-Headers': EXPOSE,
      'cache-control': 'no-store',
    },
  });
}

async function facilitatorCall(config, path, payload, requirements, fetchImpl) {
  const headers = { 'content-type': 'application/json' };
  if (config.facilitatorKey) headers.authorization = `Bearer ${config.facilitatorKey}`;
  const res = await fetchImpl(`${config.facilitator}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
  });
  if (!res.ok) throw new Error(`facilitator ${path} answered ${res.status}`);
  return res.json();
}

/**
 * Wrap one API call. People and x402-off pass straight through to run(). Agents without a
 * payment get 402 + PAYMENT-REQUIRED; with one, it is verified, run() executes, and a
 * successful response is settled and carries PAYMENT-RESPONSE.
 */
export async function withX402(request, env, run, { fetch: fetchImpl = globalThis.fetch, headers: baseHeaders = {} } = {}) {
  const config = x402FromEnv(env);
  if (!config || isPersonRequest(request)) return run();
  const signature = request.headers.get('payment-signature') || request.headers.get('x-payment');
  if (!signature) return challenge(config, request, undefined, baseHeaders);
  let payload;
  try {
    payload = b64decode(signature);
  } catch {
    return challenge(config, request, 'invalid_payment_signature', baseHeaders);
  }
  const requirements = paymentRequirements(config, request);
  try {
    const verified = await facilitatorCall(config, '/verify', payload, requirements, fetchImpl);
    if (!verified?.isValid) return challenge(config, request, verified?.invalidReason || 'payment_invalid', baseHeaders);
  } catch {
    return challenge(config, request, 'facilitator_unavailable', baseHeaders);
  }
  const response = await run();
  if (!response.ok) return response; // nothing delivered, nothing settled
  let settled;
  try {
    settled = await facilitatorCall(config, '/settle', payload, requirements, fetchImpl);
  } catch {
    return challenge(config, request, 'settlement_failed', baseHeaders);
  }
  if (!settled?.success) return challenge(config, request, settled?.errorReason || 'settlement_failed', baseHeaders);
  const out = new Headers(response.headers);
  out.set('PAYMENT-RESPONSE', b64encode(settled));
  out.set('Access-Control-Expose-Headers', EXPOSE);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
}
