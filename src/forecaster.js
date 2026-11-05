// Predictive forecasts in the browser: drives a CONJURE™ job through
// /api/forecast one step at a time, persists it, and resumes after reloads.
// Without CONJURE_URL it runs a clearly labeled demo that simulates nothing.

import { getState, update, uid, plan } from './store.js';
import { REWARD_RULES } from './data.js';
import { creditUsage } from './runner.js';

const API_URL = 'api/forecast';
export const POLL_MS = 4000;
let pollMs = POLL_MS;
export function setPollInterval(ms) { pollMs = ms; } // tests
const MAX_API_FAILURES = 5;

// Mirrors api/_conjure.js (files under api/ are functions, not static assets).
export const STAGES = [
  { id: 'ontology', label: 'Read seed material', steps: ['ontology'] },
  { id: 'graph', label: 'Build knowledge graph', steps: ['graph_build', 'graph_wait'] },
  { id: 'agents', label: 'Generate persona agents', steps: ['sim_create', 'prepare', 'prepare_wait'] },
  { id: 'simulate', label: 'Simulate reactions', steps: ['run_start', 'run_wait'] },
  { id: 'report', label: 'Write forecast report', steps: ['report_start', 'report_wait', 'report_fetch', 'done'] },
];
export const stageIndex = (step) => Math.max(0, STAGES.findIndex((s) => s.steps.includes(step)));

let liveStatus = null; // null unknown, true CONJURE configured, false demo
const drivers = new Map(); // forecastId -> { stopped }
let draft = null;

export const isForecastLive = () => liveStatus;
export function setDraft(d) { draft = d; }
export function takeDraft() { const d = draft; draft = null; return d; }

export async function checkForecastLive() {
  try {
    const res = await fetch(API_URL, { method: 'GET' });
    liveStatus = Boolean((await res.json()).live);
  } catch {
    liveStatus = false;
  }
  return liveStatus;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (body) => {
  const res = await fetch(API_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { res, data };
};

function mutate(id, fn) {
  update((st) => {
    const f = st.forecasts.find((x) => x.id === id);
    if (f) fn(f, st);
  });
}
const find = (id) => getState().forecasts.find((f) => f.id === id);

// ---------- start ----------
export async function startForecast(input) {
  const cost = REWARD_RULES.creditsPerForecast;
  if (cost > creditUsage().available) {
    return { error: `A forecast uses ${cost} AI credits and you have ${creditUsage().available} left this month on the ${plan().label} plan.` };
  }
  if (liveStatus === null) await checkForecastLive();

  let job;
  let mode = 'demo';
  if (liveStatus) {
    const { res, data } = await post({ action: 'create', ...input });
    if (res.status === 503) liveStatus = false;
    else if (!res.ok || !data.job) return { error: data.error || 'Could not start the forecast. Please retry.' };
    else { job = data.job; mode = 'live'; }
  }
  if (!job) {
    const err = validateLocally(input);
    if (err) return { error: err };
    job = demoJob(input);
  }

  const forecast = { id: uid('fc'), createdAt: Date.now(), mode, job, chat: [] };
  update((st) => {
    st.wallet.creditsUsed += cost;
    st.forecasts.unshift(forecast);
    let finished = 0;
    st.forecasts = st.forecasts.filter((f) => f.job.status === 'running' || finished++ < 20);
  });
  drive(forecast.id);
  return { forecast };
}

function validateLocally({ question, seed }) {
  if (!String(question || '').trim()) return 'Describe what you want to predict.';
  if (String(seed || '').trim().length < 40) return 'Add at least a paragraph of seed material (news, notes, a plan, data).';
  return null;
}

// ---------- drive ----------
function drive(id) {
  if (drivers.has(id)) return;
  const handle = { stopped: false };
  drivers.set(id, handle);
  const f = find(id);
  (f.mode === 'live' ? driveLive(id, handle) : driveDemo(id, handle))
    .finally(() => { if (drivers.get(id) === handle) drivers.delete(id); });
}

async function driveLive(id, handle) {
  let apiFailures = 0;
  for (;;) {
    const f = find(id);
    if (!f || handle.stopped || f.job.status !== 'running') return;
    try {
      const { res, data } = await post({ action: 'advance', job: f.job });
      if (handle.stopped) return;
      if (!res.ok || !data.job) throw new Error(data.error || `Request failed (${res.status})`);
      apiFailures = 0;
      mutate(id, (x) => { if (x.job.status === 'running') x.job = { ...data.job, report: data.job.report ?? x.job.report }; });
      if (/_wait$/.test(data.job.step) && data.job.status === 'running') await sleep(pollMs);
    } catch (err) {
      if (handle.stopped) return;
      apiFailures += 1;
      if (apiFailures >= MAX_API_FAILURES) {
        mutate(id, (x) => { x.job.status = 'failed'; x.job.error = err.message || 'The forecast service is unreachable.'; });
        return;
      }
      await sleep(pollMs * apiFailures);
    }
  }
}

// ---------- demo ----------
const DEMO_STEPS = [
  ['graph_wait', 'Building knowledge graph (demo)', 20],
  ['prepare_wait', 'Generating persona agents (demo)', 40],
  ['run_wait', 'Simulating reactions (demo)', 60],
  ['run_wait', 'Simulating reactions (demo)', 75],
  ['report_wait', 'Writing forecast report (demo)', 90],
];

function demoJob({ question, seed, rounds, platform, product, title }) {
  return {
    v: 1, step: 'ontology', status: 'running', product: product || 'SCALVS.ai',
    title: String(title || question).slice(0, 120), question: String(question).trim(), seed: String(seed).trim(),
    rounds: Math.min(40, Math.max(5, Number(rounds) || 20)), platform: platform || 'parallel',
    ids: {}, progress: 0, message: 'Reading seed material (demo)', failures: 0, report: null, error: null,
  };
}

export function demoReport(job) {
  const q = job.question.length > 140 ? `${job.question.slice(0, 137)}…` : job.question;
  return [
    '> **Demo mode: simulated output.** No agents were simulated and this is not a prediction. Set `CONJURE_URL` to connect CONJURE™ for real forecasts.',
    '',
    `## Forecast: ${q}`,
    '',
    `**Setup:** ${job.rounds} rounds on ${job.platform === 'parallel' ? 'Twitter- and Reddit-style platforms' : `a ${job.platform}-style platform`}, seeded from ${job.seed.length.toLocaleString('en-US')} characters of material.`,
    '',
    '### What a live run returns',
    '- Persona agents built from the entities in your seed material',
    '- How opinion forms and spreads round by round',
    '- Best, base and worst-case outcomes with the signals behind each',
    '- A ReportAgent you can question about any agent or turning point',
  ].join('\n');
}

async function driveDemo(id, handle) {
  try {
    for (const [step, message, progress] of DEMO_STEPS) {
      await sleep(900);
      if (handle.stopped || find(id)?.job.status !== 'running') return;
      mutate(id, (x) => { x.job.step = step; x.job.message = message; x.job.progress = progress; });
    }
    await sleep(900);
    if (handle.stopped || find(id)?.job.status !== 'running') return;
    mutate(id, (x) => {
      x.job.report = demoReport(x.job);
      x.job.step = 'done';
      x.job.status = 'completed';
      x.job.progress = 100;
      x.job.message = 'Demo complete';
    });
  } catch { /* store gone */ }
}

// ---------- stop / resume / chat ----------
export async function stopForecast(id) {
  const f = find(id);
  if (!f || f.job.status !== 'running') return;
  const h = drivers.get(id);
  if (h) h.stopped = true;
  drivers.delete(id);
  const job = f.job;
  mutate(id, (x) => { x.job.status = 'stopped'; x.job.message = 'Stopped'; });
  if (f.mode === 'live') {
    // Ask the engine to stop the simulation too; local state is already stopped.
    try { await post({ action: 'stop', job }); } catch { /* best effort */ }
  }
}

// Live forecasts are stateless on the server, so they resume after a reload.
// Demo forecasts can't, and are stopped.
export function resumeForecasts() {
  getState().forecasts.filter((f) => f.job.status === 'running' && !drivers.has(f.id)).forEach((f) => {
    if (f.mode === 'live') drive(f.id);
    else mutate(f.id, (x) => { x.job.status = 'stopped'; x.job.message = 'Interrupted by a page reload'; });
  });
}

export async function askReportAgent(id, message) {
  const f = find(id);
  message = String(message || '').trim();
  if (!f || f.job.status !== 'completed' || !message) return { error: 'Ask a question about a completed forecast.' };
  const history = f.chat.map(({ role, content }) => ({ role, content }));
  mutate(id, (x) => { x.chat.push({ role: 'user', content: message }); x.asking = true; });
  let reply;
  let error;
  if (f.mode === 'live') {
    try {
      const { res, data } = await post({ action: 'chat', job: f.job, message, history });
      if (!res.ok || !data.reply) error = data.error || 'The ReportAgent could not answer. Please retry.';
      else reply = data.reply;
    } catch {
      error = 'The ReportAgent could not be reached. Please retry.';
    }
  } else {
    await sleep(500);
    reply = '*Demo mode: simulated reply.* With CONJURE™ live, the ReportAgent searches the simulated world (agents, posts and the knowledge graph) to answer this.';
  }
  mutate(id, (x) => {
    x.asking = false;
    if (reply) x.chat.push({ role: 'assistant', content: reply });
    else x.chat.pop();
  });
  return error ? { error } : { reply };
}

export function clearFinishedForecasts() {
  update((st) => { st.forecasts = st.forecasts.filter((f) => f.job.status === 'running'); });
}
