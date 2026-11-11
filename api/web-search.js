// @search: Infinitum Search, a web answer with numbered sources.
//
//   GET  /api/search                         -> { connected, engines, answers }
//   POST /api/search { query } | { text }    -> { query, answer, sources, ... } | { mention: false }
//
// Needs a Cumulus ID token (Authorization: Bearer <cid token>), checked with the issuer; each
// person has their own rate limit. Only the typed question goes out. Off until a search engine is
// set as a Worker secret: SEARXNG_URL, YANDEX_SEARCH_API_KEY + YANDEX_FOLDER_ID, or
// BRAVE_SEARCH_API_KEY. Answers use AI_BASE_URL/AI_API_KEY/AI_MODEL or OMNIROUTE_*.
// The client in ./search is synced from InfinitumCorp/infinitum-nexus packages/ai (don't edit).
import { createSearchRoutes, searchRoutesFromEnv } from './search/search.mjs';
import { createCidVerifier } from './scalvs-agent.js';

const DEFAULT_ISSUER = 'https://id.cumuluscloud.app';

/** The /api/search handler. Options are for tests; production reads process.env. */
export function createWebSearchHandler({ env = process.env, verify, fetch, search } = {}) {
  const check = verify ?? createCidVerifier({ issuer: env.CID_ISSUER || DEFAULT_ISSUER });
  let routes;
  return async function handle(request) {
    const auth = request.headers.get('authorization') || '';
    const cid = /^Bearer\s+/i.test(auth) ? await check(auth.replace(/^Bearer\s+/i, '').trim()) : null;
    routes ??= search !== undefined ? createSearchRoutes({ search, prefix: '/api/search' }) : searchRoutesFromEnv(env, { prefix: '/api/search', fetch });
    const res = await routes(request, { user: cid });
    return res ?? new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  };
}

let shared;
const handler = (request) => (shared ??= createWebSearchHandler())(request);
export const GET = handler;
export const POST = handler;
