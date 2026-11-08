// Cloudflare Workers entry for SCALVS.ai. Static files come from Workers Static
// Assets (dist/, built by scripts/build-assets.mjs); only /api/* reaches this
// script (assets.run_worker_first in wrangler.jsonc). The handlers in api/ are
// Web-standard (Request -> Response) and read config from process.env, which
// nodejs_compat fills from the Worker's vars and secrets.
import * as run from './api/run.js';
import * as forecast from './api/forecast.js';

const ROUTES = { '/api/run': run, '/api/forecast': forecast };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const api = ROUTES[pathname.replace(/\/$/, '')];
    if (!api) return env.ASSETS.fetch(request);
    const handler = api[request.method];
    if (!handler) return new Response('Method Not Allowed', { status: 405, headers: SECURITY_HEADERS });
    // Model calls cost money and the API is public: cap POSTs per client IP.
    if (request.method === 'POST' && env.API_LIMIT) {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const { success } = await env.API_LIMIT.limit({ key: ip });
      if (!success) {
        return new Response(JSON.stringify({ error: 'Too many requests. Wait a minute and retry.' }), {
          status: 429, headers: { ...SECURITY_HEADERS, 'content-type': 'application/json', 'retry-after': '60' },
        });
      }
    }
    const response = await handler(request, env);
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
