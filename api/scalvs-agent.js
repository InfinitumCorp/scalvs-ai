// @scalvs / @scalus: the SCALVS agent, which runs on an OpenClaw gateway.
//
//   GET  /api/openclaw            -> { connected, agent }                (never the URL or token)
//   POST /api/openclaw { text, context? } -> { mention: false } | { mention: true, text, agent }
//
// Both need a Cumulus ID token (Authorization: Bearer <cid token>), checked with the issuer, so
// each person gets their own OpenClaw session ("scalvs:<cid>"). Off until OPENCLAW_GATEWAY_URL
// and OPENCLAW_GATEWAY_TOKEN are set as Worker secrets; the token never reaches a browser.
// The client in ./openclaw is synced from InfinitumCorp/infinitum-nexus packages/ai (don't edit).
import { openClawRoutesFromEnv } from './openclaw/openclaw.mjs';

const DEFAULT_ISSUER = 'https://id.cumuluscloud.app';
const CACHE_MS = 60_000;

/** The Cumulus ID (cid) behind a bearer token, or null. Server to server, so Russia's blocks don't apply. */
export function createCidVerifier({ issuer = DEFAULT_ISSUER, fetch: fetchImpl } = {}) {
  const base = String(issuer).replace(/\/+$/, '');
  const cache = new Map();
  return async function verify(token) {
    if (!token || token.length > 8000) return null;
    const hit = cache.get(token);
    if (hit && hit.until > Date.now()) return hit.cid;
    const doFetch = fetchImpl ?? globalThis.fetch;
    let res;
    try {
      res = await doFetch(`${base}/api/id/userinfo`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const cid = body && typeof body.cid === 'string' && body.cid ? body.cid : null;
    if (!cid) return null;
    if (cache.size > 500) cache.clear();
    cache.set(token, { cid, until: Date.now() + CACHE_MS });
    return cid;
  };
}

/** The /api/openclaw handler. Options are for tests; production reads process.env. */
export function createScalvsAgentHandler({ env = process.env, verify, fetch } = {}) {
  const check = verify ?? createCidVerifier({ issuer: env.CID_ISSUER || DEFAULT_ISSUER });
  return async function handle(request) {
    const auth = request.headers.get('authorization') || '';
    const cid = /^Bearer\s+/i.test(auth) ? await check(auth.replace(/^Bearer\s+/i, '').trim()) : null;
    const routes = openClawRoutesFromEnv(env, { product: 'scalvs', prefix: '/api/openclaw', fetch });
    const res = await routes(request, { user: cid });
    return res ?? new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  };
}

let shared;
const handler = (request) => (shared ??= createScalvsAgentHandler())(request);
export const GET = handler;
export const POST = handler;
