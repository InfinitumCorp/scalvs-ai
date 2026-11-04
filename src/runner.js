// Agent runtime on the client: sequences agents, handles approvals,
// meters prototype credits. Draft completion never settles rewards.

import { getState, update, uid, plan } from './store.js';
import { REWARD_RULES, TEMPLATES } from './data.js';

let liveStatus = null; // null = unknown, true = live model, false = demo

export async function checkLive() {
  try {
    const res = await fetch('/api/run', { method: 'GET' });
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

async function callAgent(agent, task, previous) {
  if (liveStatus !== false) {
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent: { name: agent.name, role: agent.role, instructions: agent.instructions, tools: agent.tools },
          context: vaultFor(agent),
          task,
          previous,
        }),
      });
      if (res.status === 503) {
        liveStatus = false;
      } else {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        if (data.mode !== 'live' || typeof data.output !== 'string' || !data.output.trim()) {
          throw new Error('The model returned no valid output. Please retry.');
        }
        liveStatus = true;
        return { output: data.output, mode: 'live' };
      }
    } catch (err) {
      throw err;
    }
  }
  await new Promise((r) => setTimeout(r, 700 + Math.random() * 700));
  return { output: demoOutput(agent, task, previous), mode: 'demo' };
}

// ---------- run lifecycle ----------
export function creditUsage() {
  const s = getState();
  const reserved = s.runs
    .filter(r => r.status === 'running' || r.status === 'awaiting_approval')
    .reduce((sum, r) => sum + r.steps.filter(step => step.status === 'queued').length * REWARD_RULES.creditsPerRun, 0);
  return { used: s.wallet.creditsUsed, reserved, available: Math.max(0, plan().credits - s.wallet.creditsUsed - reserved) };
}

export function startRun({ task, agentIds, title }) {
  if (typeof task !== 'string' || !task.trim() || task.length > 6000) return { error: 'Enter a task between 1 and 6000 characters.' };
  if (!Array.isArray(agentIds) || !agentIds.length || agentIds.some(id => !findAgent(id))) return { error: 'Choose existing agents for every team step.' };
  task = task.trim();
  const s = getState();
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
  };
  update((st) => {
    st.runs.unshift(run);
    let finished = 0;
    st.runs = st.runs.filter(r => r.status === 'running' || r.status === 'awaiting_approval' || finished++ < 40);
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
    mutateRun(runId, (r) => { r.status = 'failed'; r.error = 'Agent was deleted.'; });
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
  try {
    const { output, mode } = await callAgent(agent, run.task, previous);
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
    mutateRun(runId, (r) => {
      r.steps[idx].status = 'failed';
      r.status = 'failed';
      r.error = err.message;
    });
  }
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
  update((st) => { st.runs = st.runs.filter((r) => r.status === 'running' || r.status === 'awaiting_approval'); });
}

