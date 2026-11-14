// @scalvs / @scalus: the SCALVS agent, which runs on an OpenClaw gateway.
//
//   GET  /api/openclaw            -> { connected, agent }                (never the URL or token)
//   POST /api/openclaw { text, context? } -> { mention: false } | { mention: true, text, agent }
//
// Both need a Cumulus://ID access token (Authorization: Bearer <token>, from the sign-in button),
// verified against the issuer's JWKS and its userinfo, so each person gets their own OpenClaw
// session ("scalvs:<cid>", the token's verified sub). Off until OPENCLAW_GATEWAY_URL
// and OPENCLAW_GATEWAY_TOKEN are set as Worker secrets; the token never reaches a browser.
// The client in ./openclaw is synced from InfinitumCorp/infinitum-nexus packages/ai (don't edit).
import { openClawRoutesFromEnv } from './openclaw/openclaw.mjs';

// Cumulus://ID (contract: cumulus-id docs/integration.md). Access tokens are ES256 JWTs with
// typ "at+jwt", iss = this realm, aud = the client id ("scalvs"), sub = the cid.
const DEFAULT_ISSUER = 'https://id.cumuluscloud.app/realms/cumulus';
export const CID_CLIENT_ID = 'scalvs';
const CACHE_MS = 60_000;
const JWKS_MS = 10 * 60_000;
const CID = /^cid_[A-Za-z0-9_-]{1,64}$/;

const b64urlBytes = (text) => {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const b64urlJson = (text) => JSON.parse(new TextDecoder().decode(b64urlBytes(text)));

/**
 * Check a Cumulus://ID access token offline: ES256 signature against the issuer's JWKS,
 * typ "at+jwt", iss, aud (this product's client id), exp/nbf. Returns the verified claims or null.
 */
export async function verifyCidAccessToken(token, { issuer, audience, getKeys, now = Date.now() }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
  } catch {
    return null;
  }
  if (header?.alg !== 'ES256' || String(header.typ || '').toLowerCase() !== 'at+jwt') return null;
  const keys = await getKeys().catch(() => []);
  const jwk = keys.find((k) => k && k.kty === 'EC' && k.crv === 'P-256' && (!header.kid || k.kid === header.kid) && (!k.use || k.use === 'sig'));
  if (!jwk) return null;
  let ok = false;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return null;
  }
  if (!ok || !claims || typeof claims !== 'object') return null;
  const seconds = Math.floor(now / 1000);
  const skew = 60;
  if (claims.iss !== issuer) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) return null;
  if (typeof claims.exp !== 'number' || claims.exp + skew <= seconds) return null;
  if (typeof claims.nbf === 'number' && claims.nbf - skew > seconds) return null;
  if (typeof claims.sub !== 'string' || !CID.test(claims.sub)) return null;
  return claims;
}

/**
 * The Cumulus://ID cid behind a bearer access token, or null. The token is verified offline
 * against the JWKS, then the issuer's userinfo confirms its session is still live (a revoked
 * session stops working at once, not at expiry) and names the same subject. The verified `sub`
 * is the person; answers are cached for a minute. Server to server, so Russia's blocks don't apply.
 */
export function createCidVerifier({ issuer = DEFAULT_ISSUER, audience = CID_CLIENT_ID, fetch: fetchImpl, now = () => Date.now() } = {}) {
  const base = String(issuer).replace(/\/+$/, '');
  const oidc = `${base}/protocol/openid-connect`;
  const cache = new Map();
  const doFetch = (...args) => (fetchImpl ?? globalThis.fetch)(...args);
  let jwks = null;
  const getKeys = async () => {
    if (jwks && jwks.until > now()) return jwks.keys;
    const res = await doFetch(`${oidc}/certs`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
    const body = await res.json();
    const keys = Array.isArray(body?.keys) ? body.keys : [];
    jwks = { keys, until: now() + JWKS_MS };
    return keys;
  };
  return async function verify(token) {
    if (!token || token.length > 8000) return null;
    const hit = cache.get(token);
    if (hit && hit.until > now()) return hit.cid;
    const claims = await verifyCidAccessToken(token, { issuer: base, audience, getKeys, now: now() });
    if (!claims) return null;
    let res;
    try {
      res = await doFetch(`${oidc}/userinfo`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body || body.sub !== claims.sub) return null;
    const cid = claims.sub;
    if (cache.size > 500) cache.clear();
    cache.set(token, { cid, until: Math.min(now() + CACHE_MS, claims.exp * 1000) });
    return cid;
  };
}

/**
 * The gateway settings: OPENCLAW_GATEWAY_URL / OPENCLAW_GATEWAY_TOKEN (as on +SPCTR), or the
 * OPENCLAW_URL (".../v1") / OPENCLAW_TOKEN pair that "Run agents on OpenClaw" uses, so one
 * gateway configured once serves both.
 */
export function gatewayEnv(env) {
  const url = env.OPENCLAW_GATEWAY_URL || (env.OPENCLAW_URL ? String(env.OPENCLAW_URL).replace(/\/+$/, '').replace(/\/v1$/, '') : undefined);
  const token = env.OPENCLAW_GATEWAY_TOKEN || env.OPENCLAW_TOKEN;
  return { OPENCLAW_GATEWAY_URL: url, OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_AGENT: env.OPENCLAW_AGENT };
}

/** The /api/openclaw handler. Options are for tests; production reads process.env. */
export function createScalvsAgentHandler({ env = process.env, verify, fetch } = {}) {
  const check = verify ?? createCidVerifier({ issuer: env.CID_ISSUER || DEFAULT_ISSUER });
  return async function handle(request) {
    const auth = request.headers.get('authorization') || '';
    const cid = /^Bearer\s+/i.test(auth) ? await check(auth.replace(/^Bearer\s+/i, '').trim()) : null;
    const routes = openClawRoutesFromEnv(gatewayEnv(env), { product: 'scalvs', prefix: '/api/openclaw', fetch });
    const res = await routes(request, { user: cid });
    return res ?? new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  };
}

let shared;
const handler = (request) => (shared ??= createScalvsAgentHandler())(request);
export const GET = handler;
export const POST = handler;
