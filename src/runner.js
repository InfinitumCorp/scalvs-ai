// Agent runtime on the client: sequences agents, streams output, handles
// approvals and stops, meters prototype credits. Draft completion never
// settles rewards.

import { getState, update, uid, plan } from './store.js';
import { REWARD_RULES, TEMPLATES } from './data.js';
import { enabledPlugins } from './grok.js';

let liveStatus = null; // null = unknown, true = live model, false = demo
const API_URL = 'api/run'; // relative, so the app also works from a subfolder
const controllers = new Map(); // runId -> AbortController for the active step
// Attachments, screenshots and generated images are large: kept in memory for
// this tab only (never written to localStorage). Keyed by run id / step key.
const runOpts = new Map();
const media = new Map();
export const mediaFor = (runId, i) => media.get(`${runId}:${i}`) || {};

export async function checkLive() {
  try {
    const res = await fetch(API_URL, { method: 'GET' });
    const data = await res.json();
    liveStatus = Boolean(data.live);
  } catch {
    liveStatus = false;
  }
  return liveStatus;
}
export const isLive = () => liveStatus;

function findAgent(id) {
  return getState().agents.find((a) => a.id === id);
}

function vaultFor(agent) {
  if (!agent.memory) return [];
  return getState().vault.filter((m) => m.products.includes('SCALVS.ai')).map((m) => m.text);
}

// ---------- demo runner (no API key) ----------
function demoOutput(agent, task, previous) {
  const tpl = TEMPLATES.find((t) => t.id === agent.template) || TEMPLATES[0];
  const short = task.length > 90 ? `${task.slice(0, 87)}…` : task;
  const base = previous ? `Building on the previous agent's draft.\n\n` : '';
  const plans = {
    research: ['Define the question and criteria', 'Collect and compare sources', 'Summarize findings with confidence levels'],
    writer: ['Identify audience and goal', 'Outline the key points', 'Draft, then tighten to the house voice'],
    coder: ['Clarify inputs and edge cases', 'Implement with tests in mind', 'Explain usage and trade-offs'],
    sales: ['Research the account', 'Find a relevant hook', 'Draft outreach and queue it for approval'],
    ops: ['Map the current process', 'Break it into checkable steps', 'Add owners and a cadence'],
    support: ['Understand the customer issue', 'Check policy', 'Draft a reply and flag escalation needs'],
  }[tpl.id];
  return `${base}**Plan:** ${plans.join(' → ')}\n\n### Result for: ${short}\n\n` +
    `- ${plans[0]}: done using ${agent.tools.slice(0, 2).join(' and ') || 'built-in reasoning'}.\n` +
    `- ${plans[1]}: completed.\n` +
    `- ${plans[2]}: ready for review.\n\n` +
    `*Demo mode: simulated response. Add ANTHROPIC_API_KEY to the deployment to have ${agent.name} produce real work.*`;
}

const abortError = () => new DOMException('Stopped', 'AbortError');

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError());
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
});

// Reads the server's SSE stream, calling onText with the text so far.
// Succeeds only on an explicit "done" event; anything else is a failure.
export async function readStream(res, onText = () => {}, onExtra = () => {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let finished = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const line = buffer.slice(0, cut).split('\n').find((l) => l.startsWith('data:'));
      buffer = buffer.slice(cut + 2);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (evt.type === 'text' && typeof evt.text === 'string') { full += evt.text; onText(full); }
      else if (evt.type === 'thinking' || evt.type === 'shot' || evt.type === 'sources') onExtra(evt);
      else if (evt.type === 'error') { reader.cancel().catch(() => {}); throw new Error(evt.error || 'The model stream failed. Please retry.'); }
      else if (evt.type === 'done') finished = true;
    }
  }
  if (!finished) throw new Error('The model stream ended early. Please retry.');
  return full;
}

// The /api/run request body. geoRouting is sent only when the visitor turned it on.
export function agentPayload(agent, task, previous, geoRouting = false, opts = {}) {
  return {
    agent: { name: agent.name, role: agent.role, instructions: agent.instructions, tools: agent.tools },
    context: vaultFor(agent),
    task,
    previous,
    stream: true,
    mode: opts.mode,
    personality: opts.personality,
    images: opts.images,
    files: opts.files,
    plugins: enabledPlugins(),
    history: opts.history,
    ...(geoRouting === true ? { geoRouting: true } : {}),
  };
}

async function callAgent(agent, task, previous, { signal, onText = () => {}, opts = {} } = {}) {
  const extra = { shots: [] };
  const onExtra = (evt) => {
    if (evt.type === 'thinking') extra.thinking = evt.text;
    else if (evt.type === 'sources') extra.sources = evt.sources;
    else if (evt.type === 'shot') extra.shots.push({ url: evt.url, title: evt.title, image: evt.image });
  };
  if (opts.mode === 'imagine') {
    const res = await fetch('api/imagine', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: task }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.image) throw new Error(data.error || `Image generation failed (${res.status})`);
    extra.image = data.image;
    return { output: `Image for: *${task.slice(0, 200)}*`, mode: 'live', extra };
  }
  if (liveStatus !== false) {
    const res = await fetch(API_URL, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(agentPayload(agent, task, previous, getState().geoRouting === true, opts)),
    });
    if (res.status === 503) {
      liveStatus = false;
    } else {
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      let output;
      if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
        output = await readStream(res, onText, onExtra);
      } else {
        const data = await res.json();
        if (data.mode !== 'live') throw new Error('The model returned no valid output. Please retry.');
        output = data.output;
        if (data.thinking) extra.thinking = data.thinking;
        if (data.sources) extra.sources = data.sources;
        if (data.shots) extra.shots = data.shots;
      }
      if (typeof output !== 'string' || !output.trim()) {
        throw new Error('The model returned no valid output. Please retry.');
      }
      liveStatus = true;
      return { output, mode: 'live', extra };
    }
  }
  // Demo mode: stream a simulated answer a few words at a time.
  await sleep(400 + Math.random() * 400, signal);
  const text = demoOutput(agent, task, previous);
  const words = text.split(/(\s+)/);
  let out = '';
  for (let i = 0; i < words.length; i += 6) {
    out += words.slice(i, i + 6).join('');
    onText(out);
    await sleep(40, signal);
  }
  return { output: text, mode: 'demo', extra };
}

// ---------- run lifecycle ----------
const isActive = (r) => r.status === 'running' || r.status === 'awaiting_approval';

export function creditUsage() {
  const s = getState();
  const reserved = s.runs
    .filter(isActive)
    .reduce((sum, r) => sum + r.steps.filter(step => step.status === 'queued').length * REWARD_RULES.creditsPerRun, 0);
  return { used: s.wallet.creditsUsed, reserved, available: Math.max(0, plan().credits - s.wallet.creditsUsed - reserved) };
}

// The conversation a follow-up continues: each earlier run's task and final answer.
export function chainOf(runId) {
  const runs = getState().runs;
  const chain = [];
  for (let r = runs.find((x) => x.id === runId); r && chain.length < 12; r = runs.find((x) => x.id === r.parentId)) chain.unshift(r);
  return chain;
}
function historyFor(parentId) {
  if (!parentId) return [];
  return chainOf(parentId).flatMap((r) => {
    const answer = [...r.steps].reverse().find((st) => st.output)?.output || '';
    return [{ role: 'user', content: r.task }, ...(answer ? [{ role: 'assistant', content: answer.slice(0, 4000) }] : [])];
  });
}

export function startRun({ task, agentIds, title, opts = {} }) {
  if (typeof task !== 'string' || !task.trim() || task.length > 6000) return { error: 'Enter a task between 1 and 6000 characters.' };
  if (!Array.isArray(agentIds) || !agentIds.length || agentIds.some(id => !findAgent(id))) return { error: 'Choose existing agents for every team step.' };
  task = task.trim();
  const steps = agentIds.map(findAgent).filter(Boolean);
  if (!steps.length) return { error: 'Choose an agent or team.' };
  const needed = steps.length * REWARD_RULES.creditsPerRun;
  if (needed > creditUsage().available) {
    return { error: `Not enough AI credits this month on the ${plan().label} plan. Upgrade in Earnings → Plans.` };
  }
  const run = {
    id: uid('run'),
    title: title || steps.map((a) => a.name).join(' → '),
    task,
    status: 'running',
    createdAt: Date.now(),
    current: 0,
    steps: steps.map((a) => ({ agentId: a.id, name: a.name, status: 'queued', output: '', mode: null })),
    kind: opts.mode && opts.mode !== 'auto' ? opts.mode : undefined,
    parentId: opts.parentId || undefined,
    private: opts.private || undefined,
    attached: [...(opts.images || []).map(() => 'image'), ...(opts.files || []).map((f) => f.name)],
  };
  runOpts.set(run.id, { ...opts, history: historyFor(opts.parentId) });
  update((st) => {
    st.runs.unshift(run);
    let finished = 0;
    st.runs = st.runs.filter(r => isActive(r) || finished++ < 40);
  });
  advance(run.id);
  return { run };
}

function mutateRun(id, fn) {
  update((st) => {
    const run = st.runs.find((r) => r.id === id);
    if (run) fn(run, st);
  });
}

async function advance(runId) {
  const run = getState().runs.find((r) => r.id === runId);
  if (!run || run.status !== 'running') return;
  const idx = run.current;
  if (idx >= run.steps.length) return complete(runId);

  const step = run.steps[idx];
  const agent = findAgent(step.agentId);
  if (!agent) {
    mutateRun(runId, (r) => { r.status = 'failed'; r.error = 'Agent was deleted.'; r.steps[idx].status = 'failed'; });
    return;
  }
  // Check again after approvals or a plan change. Never charge beyond the limit.
  if (getState().wallet.creditsUsed + REWARD_RULES.creditsPerRun > plan().credits) {
    mutateRun(runId, r => { r.status = 'failed'; r.error = 'Not enough AI credits to continue this run.'; r.steps[idx].status = 'failed'; });
    return;
  }
  mutateRun(runId, (r, st) => {
    r.steps[idx].status = 'running';
    st.wallet.creditsUsed += REWARD_RULES.creditsPerRun;
  });

  const previous = idx > 0 ? run.steps[idx - 1].output : undefined;
  const controller = new AbortController();
  controllers.set(runId, controller);
  const stillRunning = (r) => !controller.signal.aborted && r.status === 'running' && r.steps[idx].status === 'running';

  // Throttle streamed text into state (each update re-renders and persists).
  let pending = null;
  let timer = null;
  const flush = () => {
    timer = null;
    if (pending == null) return;
    const text = pending;
    pending = null;
    mutateRun(runId, (r) => { if (stillRunning(r)) r.steps[idx].output = text; });
  };
  const onText = (text) => { pending = text; if (!timer) timer = setTimeout(flush, 80); };

  try {
    const { output, mode, extra = {} } = await callAgent(agent, run.task, previous, { signal: controller.signal, onText, opts: { ...(runOpts.get(runId) || {}), ...(idx > 0 ? { images: [], files: [] } : {}) } });
    if (extra.image || extra.shots?.length) media.set(`${runId}:${idx}`, { image: extra.image, shots: extra.shots });
    clearTimeout(timer);
    let next = false;
    mutateRun(runId, (r) => {
      if (!stillRunning(r)) return;
      r.steps[idx].output = output;
      r.steps[idx].mode = mode;
      if (extra.thinking) r.steps[idx].thinking = extra.thinking.slice(0, 20000);
      if (extra.sources?.length) r.steps[idx].sources = extra.sources.slice(0, 10);
      if (extra.image) r.steps[idx].hasImage = true;
      if (extra.shots?.length) r.steps[idx].shotCount = extra.shots.length;
      if (agent.approval) {
        r.steps[idx].status = 'awaiting_approval';
        r.status = 'awaiting_approval';
      } else {
        r.steps[idx].status = 'done';
        r.current = idx + 1;
        next = true;
      }
    });
    if (next) advance(runId);
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted || err?.name === 'AbortError') return; // stopRun already updated state
    mutateRun(runId, (r) => {
      if (!stillRunning(r)) return;
      r.steps[idx].status = 'failed';
      r.status = 'failed';
      r.error = err?.message || 'The agent step failed. Please retry.';
    });
  } finally {
    if (controllers.get(runId) === controller) controllers.delete(runId);
  }
}

// Stops a running or approval-pending run. The started step keeps its credit
// charge; queued steps are released.
export function stopRun(runId, reason) {
  const target = getState().runs.find(r => r.id === runId);
  if (!target || !isActive(target)) return;
  controllers.get(runId)?.abort();
  controllers.delete(runId);
  mutateRun(runId, (r) => {
    r.steps.forEach((st) => {
      if (st.status === 'running' || st.status === 'queued' || st.status === 'awaiting_approval') st.status = 'stopped';
    });
    r.status = 'stopped';
    r.finishedAt = Date.now();
    if (reason) r.error = reason;
  });
}

// Runs persisted as "running" with no live controller were cut off by a page
// reload. Stop them so they no longer hold credit reservations.
export function recoverInterrupted() {
  if (getState().runs.some((r) => r.private)) update((st) => { st.runs = st.runs.filter((r) => !r.private); });
  getState().runs
    .filter(r => r.status === 'running' && !controllers.has(r.id))
    .forEach(r => stopRun(r.id, 'Interrupted when the page was closed or reloaded.'));
}

export function approve(runId) {
  const pending = getState().runs.find(r => r.id === runId);
  if (pending?.status !== 'awaiting_approval' || pending.steps[pending.current]?.status !== 'awaiting_approval') return;
  mutateRun(runId, (r) => {
    r.steps[r.current].status = 'done';
    r.current += 1;
    r.status = 'running';
  });
  advance(runId);
}

export function reject(runId) {
  const pending = getState().runs.find(r => r.id === runId);
  if (pending?.status !== 'awaiting_approval' || pending.steps[pending.current]?.status !== 'awaiting_approval') return;
  mutateRun(runId, (r) => {
    r.steps[r.current].status = 'rejected';
    r.status = 'rejected';
  });
}

function complete(runId) {
  mutateRun(runId, (r) => {
    // Draft completion is not evidence of a verified contribution or external action.
    r.status = 'completed';
    r.verified = false;
    r.finishedAt = Date.now();
  });
}

export function clearFinished() {
  update((st) => { st.runs = st.runs.filter(isActive); });
}
