// Agent runtime on the client: sequences agents, handles approvals,
// meters credits and settles (simulated) rewards on verified runs.

import { getState, update, uid, plan, addLedger } from './store.js';
import { REWARD_RULES, TEMPLATES } from './data.js';

let liveStatus = null; // null = unknown, true = live model, false = demo
const API_URL = 'api/run';
const controllers = new Map(); // runId -> AbortController

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

const weekKey = () => {
  const d = new Date();
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-w${Math.ceil(((d - start) / 86400000 + start.getUTCDay() + 1) / 7)}`;
};

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

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Stopped', 'AbortError')); }, { once: true });
});

// Reads the server's SSE stream, calling onText for each chunk.
async function readStream(res, onText) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const line = buffer.slice(0, cut).split('\n').find((l) => l.startsWith('data:'));
      buffer = buffer.slice(cut + 2);
      if (!line) continue;
      const evt = JSON.parse(line.slice(5).trim());
      if (evt.type === 'text') { full += evt.text; onText(full); }
      else if (evt.type === 'error') throw new Error(evt.error);
    }
  }
  return full;
}

async function callAgent(agent, task, previous, { signal, onText }) {
  if (liveStatus !== false) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent: { name: agent.name, role: agent.role, instructions: agent.instructions, tools: agent.tools },
          context: vaultFor(agent),
          task,
          previous,
          stream: true,
        }),
      });
      if (res.status === 503) {
        liveStatus = false;
      } else if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        liveStatus = true;
        throw new Error(data.error || `Request failed (${res.status})`);
      } else {
        liveStatus = true;
        const output = (res.headers.get('content-type') || '').includes('text/event-stream')
          ? await readStream(res, onText)
          : (await res.json()).output;
        return { output, mode: 'live' };
      }
    } catch (err) {
      if (err.name === 'AbortError' || liveStatus === true) throw err;
      liveStatus = false;
    }
  }
  // Demo mode: stream a simulated answer word by word.
  await sleep(400 + Math.random() * 400, signal);
  const text = demoOutput(agent, task, previous);
  const words = text.split(/(\s+)/);
  let out = '';
  for (let i = 0; i < words.length; i += 6) {
    out += words.slice(i, i + 6).join('');
    onText(out);
    await sleep(40, signal);
  }
  return { output: text, mode: 'demo' };
}

// ---------- run lifecycle ----------
export function startRun({ task, agentIds, title }) {
  const s = getState();
  const steps = agentIds.map(findAgent).filter(Boolean);
  if (!steps.length) return { error: 'Choose an agent or team.' };
  const needed = steps.length * REWARD_RULES.creditsPerRun;
  if (s.wallet.creditsUsed + needed > plan().credits) {
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
  };
  update((st) => { st.runs.unshift(run); st.runs = st.runs.slice(0, 40); });
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
    mutateRun(runId, (r) => { r.status = 'failed'; r.error = 'Agent was deleted.'; });
    return;
  }
  mutateRun(runId, (r, st) => {
    r.steps[idx].status = 'running';
    st.wallet.creditsUsed += REWARD_RULES.creditsPerRun;
  });

  const previous = idx > 0 ? run.steps[idx - 1].output : undefined;
  const controller = new AbortController();
  controllers.set(runId, controller);

  // Throttle streamed text into state (each update re-renders and persists).
  let pending = null;
  let timer = null;
  const flush = () => {
    timer = null;
    if (pending == null) return;
    const text = pending;
    pending = null;
    mutateRun(runId, (r) => { if (r.steps[idx].status === 'running') r.steps[idx].output = text; });
  };
  const onText = (text) => { pending = text; if (!timer) timer = setTimeout(flush, 80); };

  try {
    const { output, mode } = await callAgent(agent, run.task, previous, { signal: controller.signal, onText });
    clearTimeout(timer);
    controllers.delete(runId);
    mutateRun(runId, (r) => {
      r.steps[idx].output = output;
      r.steps[idx].mode = mode;
      if (agent.approval) {
        r.steps[idx].status = 'awaiting_approval';
        r.status = 'awaiting_approval';
      } else {
        r.steps[idx].status = 'done';
        r.current = idx + 1;
      }
    });
    if (!agent.approval) advance(runId);
  } catch (err) {
    clearTimeout(timer);
    controllers.delete(runId);
    if (err.name === 'AbortError') return; // stopRun already updated state
    mutateRun(runId, (r) => {
      r.steps[idx].status = 'failed';
      r.status = 'failed';
      r.error = err.message;
    });
  }
}

export function stopRun(runId) {
  controllers.get(runId)?.abort();
  controllers.delete(runId);
  mutateRun(runId, (r) => {
    r.steps.forEach((st) => { if (st.status === 'running' || st.status === 'queued') st.status = 'stopped'; });
    r.status = 'stopped';
  });
}

export function approve(runId) {
  mutateRun(runId, (r) => {
    r.steps[r.current].status = 'done';
    r.current += 1;
    r.status = 'running';
  });
  advance(runId);
}

export function reject(runId) {
  mutateRun(runId, (r) => {
    r.steps[r.current].status = 'rejected';
    r.status = 'rejected';
  });
}

function complete(runId) {
  mutateRun(runId, (r, st) => {
    // Verification: every step produced output and was approved where required.
    const verified = r.steps.every((s) => s.status === 'done' && s.output.trim().length > 0);
    r.status = 'completed';
    r.verified = verified;
    r.finishedAt = Date.now();
    if (!verified) return;

    const w = st.wallet;
    w.activity += REWARD_RULES.activityPerVerified;
    addLedger({ kind: 'activity', amount: REWARD_RULES.activityPerVerified, unit: 'credits', note: `Verified run: ${r.title}` });

    const wk = weekKey();
    if (w.week !== wk) { w.week = wk; w.sclvThisWeek = 0; }
    const room = Math.max(0, REWARD_RULES.sclvWeeklyCap - w.sclvThisWeek);
    const reward = Math.min(REWARD_RULES.sclvPerVerified, room);
    if (reward > 0) {
      w.sclv += reward;
      w.sclvThisWeek += reward;
      addLedger({ kind: 'sclv', amount: reward, unit: '$SCLV', note: 'Capped reward for verified contribution' });
    }
  });
}

export function clearFinished() {
  update((st) => { st.runs = st.runs.filter((r) => r.status === 'running' || r.status === 'awaiting_approval'); });
}
