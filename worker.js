// Cloudflare Workers entry for SCALVS.ai. Static files come from Workers Static
// Assets (dist/, built by scripts/build-assets.mjs); only /api/* reaches this
// script (assets.run_worker_first in wrangler.jsonc). The handlers in api/ are
// Web-standard (Request -> Response) and read config from process.env, which
// nodejs_compat fills from the Worker's vars and secrets.
import * as run from './api/run.js';
import * as forecast from './api/forecast.js';
import * as connectors from './api/connectors.js';
import * as automations from './api/automations.js';
import { imagine, share } from './api/grok.js';
import * as scalvsAgent from './api/scalvs-agent.js';
import * as search from './api/search.js';
import { budgetedAI, FreeAllowanceUsed } from './api/_ai-budget.js';
import { langfuseFromEnv, tracedAI } from './api/_ai-langfuse.mjs';
import { withX402 } from './api/_x402.js';

// Every Workers AI call on the account is charged to one shared ledger (the conjure-llm
// Worker's Budget Durable Object), so usage stays inside the free 10,000 neurons a day.
const budgeted = (env, ctx) => (env.AI && env.AI_BUDGET ? { ...env, AI: budgetedAI(env.AI, env.AI_BUDGET, { waitUntil: ctx?.waitUntil?.bind(ctx) }) } : env);
// Langfuse: one span per Workers AI call (model, latency, tokens, errors; no prompts unless
// LANGFUSE_CAPTURE_CONTENT=on). On whenever LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY are set; LANGFUSE=off disables.
const withBudget = (env, ctx) => {
  const out = budgeted(env, ctx);
  const tracer = out.AI ? langfuseFromEnv(env, { product: 'scalvs' }) : null;
  return tracer ? { ...out, AI: tracedAI(out.AI, tracer, { waitUntil: ctx?.waitUntil?.bind(ctx) }) } : out;
};

const ROUTES = { '/api/run': run, '/api/forecast': forecast, '/api/imagine': { POST: imagine }, '/api/share': { GET: share, POST: share }, '/api/openclaw': scalvsAgent, '/api/search': search };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export default {
  async fetch(request, rawEnv, ctx) {
    const env = withBudget(rawEnv, ctx);
    const { pathname } = new URL(request.url);
    const isConnectors = pathname.startsWith('/api/connectors') || pathname === '/api/oauth/callback';
    const isAutomations = pathname.startsWith('/api/automations');
    const api = isConnectors ? { [request.method]: connectors.handle }
      : isAutomations ? { [request.method]: automations.handle }
      : ROUTES[pathname.replace(/\/$/, '')];
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
    const call = async () => {
      try {
        return await handler(request, env, ctx);
      } catch (err) {
        if (!(err instanceof FreeAllowanceUsed)) throw err;
        return new Response(JSON.stringify({ error: err.message }), {
          status: 429, headers: { ...SECURITY_HEADERS, 'content-type': 'application/json' },
        });
      }
    };
    // x402: AI agents and scripts pay per request (default $0.001 USDC on Base); people on
    // scalvs.app stay free. Inert until X402_PAY_TO is set; X402=off disables. Connectors,
    // OAuth and automations are cookie-bound site features and are never gated.
    const response = isConnectors || isAutomations ? await call() : await withX402(request, env, call);
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    // redirects (OAuth) keep their Location; Response.redirect headers are immutable, so copy
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  // Cron (wrangler.jsonc triggers.crons): run due automations.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(automations.runDue(withBudget(env, ctx)));
  },
};
