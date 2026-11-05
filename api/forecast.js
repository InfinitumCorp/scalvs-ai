// Predictive forecasting API — Vercel serverless function backed by CONJURE™.
//
//   GET  /api/forecast                         -> { ok, live }
//   POST /api/forecast { action: "create", question, seed, rounds?, platform?, product?, title? } -> { job }
//   POST /api/forecast { action: "advance", job }                -> { job }   (one upstream step)
//   POST /api/forecast { action: "stop", job }                   -> { job }
//   POST /api/forecast { action: "chat", job, message, history? } -> { reply }
//
// Set CONJURE_URL to the self-hosted CONJURE engine (unmodified MiroFish) and
// optionally CONJURE_TOKEN if it sits behind an auth gateway. Without it the
// endpoint answers 503 { mode: "demo" } and clients run a labeled simulation.

import { advanceJob, createJob, conjureClient, LIMITS } from './_conjure.js';

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

export async function POST(request) {
  const { baseUrl, token } = config();
  if (!baseUrl) return json({ mode: 'demo', error: 'CONJURE_URL is not configured' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
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

export function GET() {
  return json({ ok: true, live: Boolean(config().baseUrl) });
}
