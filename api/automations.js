// Automations (Grok "Tasks"): agent tasks saved on the server that run on a
// schedule, whether or not the page is open. A Cloudflare cron (wrangler.jsonc
// triggers.crons, every 15 min) calls runDue(); each due automation runs through
// /api/run's own handler (all modes: think, deepsearch, browse) and keeps its
// last 10 results.
//
//   GET    /api/automations              -> { automations }
//   POST   /api/automations              { name, task, agent, mode, every, hour? } -> { automation }
//   POST   /api/automations/:id          { enabled } -> { automation }
//   POST   /api/automations/:id/run      -> { automation }   (runs now)
//   DELETE /api/automations/:id          -> { ok }

import { kv, randomId, readSession, sessionCookie, sha256 } from './_vault.js';
import * as run from './run.js';

const EVERY = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3 };
const MAX_PER_OWNER = 20;
const INDEX = 'auto:index';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
});

// Next run time: hourly from now; daily/weekly at the chosen UTC hour.
export function nextRun(a, from = Date.now()) {
  if (a.every === 'hour') return from + EVERY.hour;
  const d = new Date(from);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(Number.isInteger(a.hour) ? a.hour : 9);
  while (d.getTime() <= from) d.setTime(d.getTime() + EVERY.day);
  if (a.every === 'week') while (d.getTime() - from < EVERY.week - EVERY.day) d.setTime(d.getTime() + EVERY.day);
  return d.getTime();
}

// The dev in-memory KV ignores the 'json' type, so parse here.
async function getJson(env, key) {
  const v = await kv(env).get(key);
  if (!v) return null;
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; }
}
const load = async (env, owner) => (await getJson(env, `auto:${owner}`)) || [];
const save = async (env, owner, list) => kv(env).put(`auto:${owner}`, JSON.stringify(list));
async function addToIndex(env, owner) {
  const idx = (await getJson(env, INDEX)) || [];
  if (!idx.includes(owner)) { idx.push(owner); await kv(env).put(INDEX, JSON.stringify(idx)); }
}

async function execute(env, a) {
  const req = new Request('https://scalvs.internal/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: a.agent, task: a.task, mode: a.mode, personality: a.personality, stream: false }),
  });
  let result;
  try {
    const res = await run.POST(req, env);
    const data = await res.json();
    result = res.ok && data.output ? { at: Date.now(), ok: true, output: String(data.output).slice(0, 20000), shots: (data.shots || []).slice(-2) }
      : { at: Date.now(), ok: false, error: data.error || `Failed (${res.status})` };
  } catch (e) {
    result = { at: Date.now(), ok: false, error: String(e?.message || e).slice(0, 300) };
  }
  a.runs = [result, ...(a.runs || []).map(({ shots, ...r }) => r)].slice(0, 10); // screenshots only on the latest run
  a.lastRun = result.at;
  a.next = nextRun(a);
  return a;
}

// Cron entry: runs every due automation (at most 10 per tick to bound cost).
export async function runDue(env) {
  const idx = (await getJson(env, INDEX)) || [];
  let budget = 10;
  for (const owner of idx) {
    if (budget <= 0) break;
    const list = await load(env, owner);
    let changed = false;
    for (const a of list) {
      if (budget <= 0) break;
      if (!a.enabled || a.next > Date.now()) continue;
      budget--;
      await execute(env, a);
      changed = true;
    }
    if (changed) await save(env, owner, list);
  }
}

function clean(body) {
  const every = EVERY[body?.every] ? body.every : 'day';
  const hour = Number.isInteger(body?.hour) && body.hour >= 0 && body.hour < 24 ? body.hour : 9;
  const agent = body?.agent || {};
  return {
    name: String(body?.name || body?.task || 'Automation').trim().slice(0, 80),
    task: String(body?.task || '').trim().slice(0, 6000),
    mode: ['think', 'deepsearch', 'browse', 'auto'].includes(body?.mode) ? body.mode : 'auto',
    personality: typeof body?.personality === 'string' ? body.personality.slice(0, 20) : '',
    agent: { name: String(agent.name || 'Agent').slice(0, 80), role: String(agent.role || '').slice(0, 200), instructions: String(agent.instructions || '').slice(0, 2000), tools: [] },
    every, hour,
  };
}

export async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return json({ error: 'Cross-site request refused' }, 403);
  }
  let sid = readSession(request);
  const setCookie = {};
  if (!sid) { sid = randomId(32); setCookie['set-cookie'] = sessionCookie(sid, request); }
  const owner = await sha256(`auto:${sid}`);
  const list = await load(env, owner);
  const [, , , id, action] = url.pathname.split('/'); // /api/automations/:id/:action
  const out = (body, status = 200) => json(body, status, setCookie);

  if (request.method === 'GET') return out({ automations: list });

  if (request.method === 'POST' && !id) {
    const body = await request.json().catch(() => null);
    const a = clean(body);
    if (!a.task) return out({ error: 'Describe the task to automate.' }, 400);
    if (list.length >= MAX_PER_OWNER) return out({ error: `You can keep up to ${MAX_PER_OWNER} automations.` }, 400);
    const auto = { id: randomId(9), ...a, enabled: true, createdAt: Date.now(), next: nextRun(a), runs: [] };
    list.unshift(auto);
    await save(env, owner, list);
    await addToIndex(env, owner);
    return out({ automation: auto }, 201);
  }

  const a = list.find((x) => x.id === id);
  if (!a) return out({ error: 'Automation not found' }, 404);

  if (request.method === 'DELETE') {
    await save(env, owner, list.filter((x) => x.id !== id));
    return out({ ok: true });
  }
  if (request.method === 'POST' && action === 'run') {
    await execute(env, a);
    await save(env, owner, list);
    return out({ automation: a });
  }
  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if (typeof body.enabled === 'boolean') { a.enabled = body.enabled; if (a.enabled) a.next = nextRun(a); }
    await save(env, owner, list);
    return out({ automation: a });
  }
  return out({ error: 'Method Not Allowed' }, 405);
}
