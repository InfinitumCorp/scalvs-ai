// CONJURE™ product API engine for SCALVS.ai forecasts.
//
// When CONJURE_URL and CONJURE_PRODUCT_KEY are set, forecasts run on Conjure's /v1 API
// (the Conjure Russia server; https://conjure.infinitumcorporation.ai is its global host):
//
//   POST /v1/predictions {question, context, user, source, agents, rounds} -> 202 { id, status }
//   GET  /v1/predictions/:id                    until status is done | failed | cancelled
//   POST /v1/predictions/:id/interview          chat with one simulated persona
//   POST /v1/predictions/:id/cancel             stop
//
// The product key (Bearer cjp_scalvs_…) stays on the server. The job still round-trips
// through the browser exactly like the other engines, and each advance makes at most one
// upstream request, so it keeps the step names the UI already knows:
//   ontology (start) -> prepare_wait (queued / building agents) -> run_wait (rounds)
//   -> report_wait (writing the forecast) -> done.

import { createConjure, ConjureApiError } from './_conjure-client.js';
import { createJob } from './_conjure.js';

export const ENGINE = 'conjure-api';
// Conjure's own limits (src/predict/service.js): question 500, context 30,000, rounds 1-8, agents 4-60.
export const API_LIMITS = { question: 500, context: 30000, maxRounds: 8, agents: 16 };
const MAX_POLL_FAILURES = 5;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const STEPS = new Set(['ontology', 'prepare_wait', 'run_wait', 'report_wait', 'done']);
const CALL_TIMEOUT_MS = 30000;
const CHAT_TIMEOUT_MS = 120000;

const clip = (v, n) => String(v ?? '').slice(0, n);
const signal = (ms = CALL_TIMEOUT_MS) => AbortSignal.timeout(ms);

export function apiConfig(env = process.env) {
  const url = env.CONJURE_URL || '';
  const key = env.CONJURE_PRODUCT_KEY || '';
  return url && key ? { url, key } : null;
}

export function apiClient({ url, key }, fetchImpl = (...a) => globalThis.fetch(...a)) {
  const client = createConjure({ url, key, fetch: fetchImpl });
  const base = String(url).replace(/\/+$/, '');
  // The full view (with personas) for chat; the shared client only reads the short view.
  client.getFull = async (id, sig) => {
    const res = await fetchImpl(`${base}/v1/predictions/${encodeURIComponent(id)}?full=1`, {
      method: 'GET', headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, signal: sig,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new ConjureApiError(data?.error || `Conjure API ${res.status}`, res.status, data);
    return data;
  };
  return client;
}

// SCALVS lets people pick 10, 20 or 40 rounds; Conjure plays 1-8 deeper rounds.
export const conjureRounds = (rounds) => Math.max(1, Math.min(API_LIMITS.maxRounds, Math.round((Number(rounds) || 20) / 5)));

export function createApiJob(input) {
  const { job, error } = createJob(input);
  return error ? { error } : { job: { ...job, engine: ENGINE } };
}

// The job comes back from the browser: re-validate everything before it reaches a URL.
export function normalizeApiJob(raw) {
  if (!raw || typeof raw !== 'object' || raw.engine !== ENGINE || !STEPS.has(raw.step)) return null;
  const { job } = createJob(raw);
  if (!job) return null;
  const ids = {};
  if (raw.ids?.prediction_id != null) {
    if (typeof raw.ids.prediction_id !== 'string' || !ID.test(raw.ids.prediction_id)) return null;
    ids.prediction_id = raw.ids.prediction_id;
  }
  if (raw.step !== 'ontology' && !ids.prediction_id) return null;
  const finite = (n) => (Number.isFinite(n) ? n : null);
  return {
    ...job,
    engine: ENGINE,
    step: raw.step,
    status: ['running', 'completed', 'failed', 'stopped'].includes(raw.status) ? raw.status : 'failed',
    ids,
    failures: Math.max(0, Math.min(10, Number(raw.failures) || 0)),
    progress: Math.max(0, Math.min(100, Number(raw.progress) || 0)),
    message: clip(raw.message, 200),
    report: typeof raw.report === 'string' ? raw.report.slice(0, 200000) : null,
    error: typeof raw.error === 'string' ? raw.error.slice(0, 500) : null,
    stats: raw.stats && typeof raw.stats === 'object' ? { rounds: finite(raw.stats.rounds), actions: finite(raw.stats.actions) } : undefined,
  };
}

// The question goes in whole when it fits; a longer one is shortened and kept in full in the context.
export function predictionRequest(job) {
  const question = job.question.length > API_LIMITS.question
    ? `${job.question.slice(0, API_LIMITS.question - 1).trimEnd()}…` : job.question;
  const parts = [`Requested from ${job.product} (Infinitum SCALVS.ai).`];
  if (question !== job.question) parts.push(`Full question:\n${job.question}`);
  parts.push(`Seed material:\n${job.seed}`);
  return {
    question,
    context: parts.join('\n\n').slice(0, API_LIMITS.context),
    // /api/forecast has no sign-in yet, so there is no person to name; Conjure scopes by product key.
    user: 'scalvs-web',
    source: 'scalvs',
    agents: API_LIMITS.agents,
    rounds: conjureRounds(job.rounds),
  };
}

const sumActions = (stats) => (Array.isArray(stats) && stats.length
  ? stats.reduce((n, s) => n + (Number(s?.posts) || 0) + (Number(s?.replies) || 0) + (Number(s?.likes) || 0) + (Number(s?.reposts) || 0), 0)
  : null);

const list = (title, items) => (Array.isArray(items) && items.length
  ? `\n\n## ${title}\n${items.slice(0, 8).map((x) => `- ${clip(x, 400)}`).join('\n')}` : '');

// Conjure's structured report -> the markdown report the Forecasts view renders.
export function reportMarkdown(p) {
  const r = p.report;
  const pct = Math.round(Math.max(0, Math.min(1, Number(r.probability) || 0)) * 100);
  const pole = clip(p.poles?.for || 'it happens', 200);
  const head = `# ${clip(r.outcome || 'Forecast', 400)}\n\n**${pct}% likely** that ${pole}`
    + ` · ${clip(r.confidence || 'medium', 10)} confidence · ${Number(p.agents) || 0} agents over ${Number(p.rounds) || 0} rounds`;
  const body = typeof r.forecast === 'string' && r.forecast.trim() ? `\n\n${clip(r.forecast.trim(), 20000)}` : '';
  return `${head}${body}${list('Drivers', r.drivers)}${list('Signals to watch', r.signals)}${list('Assumptions', r.assumptions)}`
    + '\n\n_CONJURE™ forecasts are simulations of likely reactions, not guarantees._';
}

// Maps one GET /v1/predictions/:id onto the job. Returns the step, message and inner progress.
function progressOf(p) {
  const rounds = Number(p.rounds) || 0;
  const round = Number(p.round) || 0;
  if (p.status === 'queued') return { step: 'prepare_wait', message: 'Queued on CONJURE', progress: 10 };
  if (round <= 0) return { step: 'prepare_wait', message: 'Building the world and persona agents', progress: 30 };
  if (rounds && round >= rounds) return { step: 'report_wait', message: 'ReportAgent writing forecast', progress: 90 };
  const actions = sumActions(p.stats);
  return {
    step: 'run_wait',
    message: `Simulation running · round ${round}/${rounds || '?'}${actions != null ? ` · ${actions} agent actions` : ''}`,
    progress: 40 + Math.round((45 * round) / (rounds || round + 1)),
  };
}

const failed = (next, error) => Object.assign(next, { status: 'failed', message: 'Failed', error });

// Performs one upstream request and returns the next job. Never throws.
export async function advanceApiJob(job, client) {
  if (!job || job.status !== 'running') return job;
  const next = structuredClone(job);
  try {
    if (next.step === 'ontology') {
      const started = await client.start(predictionRequest(next), signal());
      if (typeof started?.id !== 'string' || !ID.test(started.id)) throw new ConjureApiError('CONJURE returned no valid forecast id.', 502);
      next.ids = { prediction_id: started.id };
      Object.assign(next, { step: 'prepare_wait', message: 'Queued on CONJURE', progress: Math.max(next.progress, 10) });
    } else {
      const p = await client.get(next.ids.prediction_id, signal());
      next.stats = { rounds: Number.isFinite(p.round) ? p.round : null, actions: sumActions(p.stats) };
      if (p.status === 'done') {
        if (!p.report || typeof p.report !== 'object') throw new ConjureApiError('The forecast report was empty.', 502);
        Object.assign(next, { step: 'done', status: 'completed', progress: 100, message: 'Forecast complete', report: reportMarkdown(p).slice(0, 200000) });
      } else if (p.status === 'failed') {
        failed(next, `CONJURE could not finish this forecast: ${clip(p.error || 'unknown error', 300)}`);
      } else if (p.status === 'cancelled') {
        failed(next, 'The forecast was cancelled on CONJURE.');
      } else {
        const s = progressOf(p);
        Object.assign(next, { step: s.step, message: s.message, progress: Math.max(Number(job.progress) || 0, Math.min(99, s.progress)) });
      }
    }
    if (next.status === 'running' || next.status === 'completed') next.failures = 0;
  } catch (err) {
    const status = err instanceof ConjureApiError ? err.status : 0;
    // Network errors, timeouts, 429 and 5xx may pass; a 4xx means the request itself is wrong.
    const transient = !status || status === 429 || status >= 500;
    next.failures = (job.failures || 0) + 1;
    const isPoll = job.step !== 'ontology'; // starting again could double-submit (and double-bill)
    if (transient && isPoll && next.failures < MAX_POLL_FAILURES) {
      next.message = 'CONJURE did not answer. Retrying…';
    } else if (status === 429) {
      failed(next, 'CONJURE’s daily forecast limit for SCALVS.ai is reached. Try again tomorrow.');
    } else if (status === 401 || status === 403) {
      failed(next, 'SCALVS.ai’s CONJURE product key was refused.');
    } else if (status === 400 && job.step === 'ontology') {
      failed(next, `CONJURE refused the forecast: ${clip(err.message, 300)}`);
    } else {
      failed(next, isPoll ? 'CONJURE could not be reached while the forecast ran.' : 'CONJURE could not start the forecast.');
    }
  }
  return next;
}

export async function stopApiJob(job, client) {
  if (job.ids.prediction_id && job.status === 'running') {
    try { await client.cancel(job.ids.prediction_id, signal()); } catch { /* best effort; stopped locally either way */ }
  }
  return { ...job, status: 'stopped', message: 'Stopped' };
}

// "Ask the ReportAgent" interviews one simulated persona: the one asked for, else the most influential.
export async function chatApiJob(job, message, client, agentId) {
  const full = await client.getFull(job.ids.prediction_id, signal());
  const personas = Array.isArray(full?.personas) ? full.personas.filter((p) => typeof p?.id === 'string') : [];
  const persona = personas.find((p) => p.id === agentId)
    || personas.reduce((best, p) => ((Number(p.influence) || 0) > (Number(best?.influence) || 0) ? p : best), personas[0]);
  if (!persona) throw new ConjureApiError('This forecast has no agents to interview.', 502);
  const d = await client.interview(job.ids.prediction_id, persona.id, message, signal(CHAT_TIMEOUT_MS));
  const answer = typeof d?.answer === 'string' ? d.answer.trim() : '';
  if (!answer) return '';
  const who = `**${clip(persona.name || persona.id, 80)}**${persona.role ? ` (${clip(persona.role, 80)})` : ''}, simulated persona:`;
  return `${who}\n\n${answer}`;
}
