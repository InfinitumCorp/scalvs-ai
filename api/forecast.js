// Predictive forecasting API — Vercel serverless function backed by CONJURE™.
//
//   GET  /api/forecast                         -> { ok, live }
//   POST /api/forecast { action: "create", question, seed, rounds?, platform?, product?, title? } -> { job }
//   POST /api/forecast { action: "advance", job }                -> { job }   (one upstream step)
//   POST /api/forecast { action: "stop", job }                   -> { job }
//   POST /api/forecast { action: "chat", job, message, history? } -> { reply }
//
// Engines, in order of preference:
//  1. CONJURE_URL + CONJURE_PRODUCT_KEY: Conjure's product API (/v1, key cjp_scalvs_…), see _conjure-api.js.
//  2. CONJURE_URL (+ CONJURE_TOKEN): an external CONJURE engine (unmodified MiroFish).
//  3. The Worker's AI binding: CONJURE (nexus engine) runs inside this Worker on Workers AI.
//  4. None: 503 { mode: "demo" } and clients run a labeled simulation.

import { advanceJob, createJob, conjureClient, LIMITS } from './_conjure.js';
import { advanceLocal, chatLocal } from './_conjure-local.js';
import { hasWorkersAi, workersAiComplete, workersAiModel } from './_workers-ai.js';
import {
  apiConfig, apiClient, createApiJob, normalizeApiJob, advanceApiJob, stopApiJob, chatApiJob,
} from './_conjure-api.js';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const STEPS = new Set(['ontology', 'graph_build', 'graph_wait', 'sim_create', 'prepare', 'prepare_wait',
  'run_start', 'run_wait', 'report_start', 'report_wait', 'report_fetch', 'done']);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// MIROFISH_* names are still accepted for older deployments.
const config = () => ({
  baseUrl: process.env.CONJURE_URL || process.env.MIROFISH_URL,
  token: process.env.CONJURE_TOKEN || process.env.MIROFISH_TOKEN,
});

// The job round-trips through the browser, so treat it as untrusted input.
export function normalizeJob(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { job } = createJob(raw);
  if (!job || !STEPS.has(raw.step)) return null;
  const ids = {};
  for (const k of ['project_id', 'task_id', 'graph_id', 'simulation_id', 'report_id']) {
    if (raw.ids?.[k] != null) {
      if (typeof raw.ids[k] !== 'string' || !ID.test(raw.ids[k])) return null;
      ids[k] = raw.ids[k];
    }
  }
  return {
    ...job,
    step: raw.step,
    status: ['running', 'completed', 'failed', 'stopped'].includes(raw.status) ? raw.status : 'failed',
    ids,
    failures: Math.max(0, Math.min(10, Number(raw.failures) || 0)),
    progress: Math.max(0, Math.min(100, Number(raw.progress) || 0)),
    stats: raw.stats && typeof raw.stats === 'object'
      ? { rounds: Number.isFinite(raw.stats.rounds) ? raw.stats.rounds : null, actions: Number.isFinite(raw.stats.actions) ? raw.stats.actions : null }
      : undefined,
  };
}

// Local-engine jobs also carry the simulation and, once done, the report.
function normalizeLocalJob(raw) {
  const job = normalizeJob(raw);
  if (!job) return null;
  return {
    ...job,
    engine: 'conjure-local',
    sim: raw.sim && typeof raw.sim === 'object' ? raw.sim : null,
    report: typeof raw.report === 'string' ? raw.report.slice(0, 200000) : null,
    error: typeof raw.error === 'string' ? raw.error.slice(0, 500) : null,
  };
}

async function localPost(body, env) {
  const model = workersAiModel();
  const complete = workersAiComplete(env, model);
  switch (body?.action) {
    case 'create': {
      const { job, error } = createJob(body);
      return error ? json({ error }, 400) : json({ mode: 'live', job: { ...job, engine: 'conjure-local', sim: null } });
    }
    case 'advance': {
      const job = normalizeLocalJob(body.job);
      if (!job) return json({ error: 'Invalid forecast job' }, 400);
      return json({ mode: 'live', job: await advanceLocal(job, complete, model) });
    }
    case 'stop': {
      const job = normalizeLocalJob(body.job);
      if (!job) return json({ error: 'Invalid forecast job' }, 400);
      return json({ mode: 'live', job: { ...job, status: 'stopped', message: 'Stopped' } });
    }
    case 'chat': {
      const job = normalizeLocalJob(body.job);
      const message = String(body.message ?? '').slice(0, LIMITS.question).trim();
      if (!job || job.status !== 'completed' || !job.report) return json({ error: 'Chat is available once the forecast is complete.' }, 400);
      if (!message) return json({ error: 'Missing message' }, 400);
      const history = (Array.isArray(body.history) ? body.history : []).slice(-10)
        .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
      try {
        const reply = await chatLocal(job, message, history, complete);
        return reply ? json({ mode: 'live', reply: reply.slice(0, 20000) }) : json({ error: 'No answer. Please retry.' }, 502);
      } catch {
        return json({ error: 'The report analyst could not answer. Please retry.' }, 502);
      }
    }
    default:
      return json({ error: 'Unknown action' }, 400);
  }
}

async function apiPost(body, cfg) {
  const client = apiClient(cfg);
  switch (body?.action) {
    case 'create': {
      const { job, error } = createApiJob(body);
      return error ? json({ error }, 400) : json({ mode: 'live', job });
    }
    case 'advance': {
      const job = normalizeApiJob(body.job);
      if (!job) return json({ error: 'Invalid forecast job' }, 400);
      return json({ mode: 'live', job: await advanceApiJob(job, client) });
    }
    case 'stop': {
      const job = normalizeApiJob(body.job);
      if (!job) return json({ error: 'Invalid forecast job' }, 400);
      return json({ mode: 'live', job: await stopApiJob(job, client) });
    }
    case 'chat': {
      const job = normalizeApiJob(body.job);
      const message = String(body.message ?? '').slice(0, 1000).trim();
      if (!job?.ids.prediction_id || job.status !== 'completed') return json({ error: 'Chat is available once the forecast is complete.' }, 400);
      if (!message) return json({ error: 'Missing message' }, 400);
      const agentId = typeof body.agentId === 'string' && /^[\w-]{1,20}$/.test(body.agentId) ? body.agentId : undefined;
      try {
        const reply = await chatApiJob(job, message, client, agentId);
        return reply ? json({ mode: 'live', reply: reply.slice(0, 20000) }) : json({ error: 'No answer. Please retry.' }, 502);
      } catch {
        return json({ error: 'The CONJURE agents could not answer. Please retry.' }, 502);
      }
    }
    default:
      return json({ error: 'Unknown action' }, 400);
  }
}

export async function POST(request, env) {
  const { baseUrl, token } = config();
  const productApi = apiConfig();
  if (!baseUrl && !hasWorkersAi(env)) return json({ mode: 'demo', error: 'No forecasting engine is configured' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  if (productApi) return apiPost(body, productApi);
  if (!baseUrl) return localPost(body, env);
  const client = conjureClient({ baseUrl, token });

  switch (body?.action) {
    case 'create': {
      const { job, error } = createJob(body);
      return error ? json({ error }, 400) : json({ mode: 'live', job });
    }
    case 'advance': {
      const job = normalizeJob(body.job);
      if (!job) return json({ error: 'Invalid forecast job' }, 400);
      return json({ mode: 'live', job: await advanceJob(job, client) });
    }
    case 'stop': {
      const job = normalizeJob(body.job);
      if (!job) return json({ error: 'Invalid forecast job' }, 400);
      if (job.ids.simulation_id && ['run_start', 'run_wait'].includes(job.step)) {
        try { await client.stop(job.ids.simulation_id); } catch { /* best effort; the job is stopped locally either way */ }
      }
      return json({ mode: 'live', job: { ...job, status: 'stopped', message: 'Stopped' } });
    }
    case 'chat': {
      const job = normalizeJob(body.job);
      const message = String(body.message ?? '').slice(0, LIMITS.question).trim();
      if (!job?.ids.simulation_id || job.status !== 'completed') return json({ error: 'Chat is available once the forecast is complete.' }, 400);
      if (!message) return json({ error: 'Missing message' }, 400);
      const history = (Array.isArray(body.history) ? body.history : []).slice(-10)
        .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
      try {
        const d = await client.chat(job.ids.simulation_id, message, history);
        const reply = typeof d.response === 'string' ? d.response.trim() : '';
        if (!reply) return json({ error: 'The ReportAgent returned no answer. Please retry.' }, 502);
        return json({ mode: 'live', reply: reply.slice(0, 20000) });
      } catch {
        return json({ error: 'The ReportAgent could not answer. Please retry.' }, 502);
      }
    }
    default:
      return json({ error: 'Unknown action' }, 400);
  }
}

export function GET(_request, env) {
  return json({ ok: true, live: Boolean(config().baseUrl) || hasWorkersAi(env) });
}
