import { getState, plan } from '../store.js';
import { TEMPLATES, REWARD_RULES } from '../data.js';
import { startRun, approve, reject, clearFinished, isLive } from '../runner.js';
import { esc, md, ago, fmt, statusLabel, toast } from '../ui.js';

let target = null;   // "agent:<id>" | "team:<id>"
let taskDraft = '';
const expanded = new Set();

function resolveTarget() {
  const s = getState();
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  if (q.get('agent')) target = `agent:${q.get('agent')}`;
  if (q.get('team')) target = `team:${q.get('team')}`;
  const valid = (t) => {
    if (!t) return false;
    const [kind, id] = t.split(':');
    return kind === 'agent' ? s.agents.some((a) => a.id === id) : s.teams.some((x) => x.id === id);
  };
  if (!valid(target)) target = s.agents[0] ? `agent:${s.agents[0].id}` : null;
}

function exampleFor() {
  if (!target) return 'Describe an outcome…';
  const s = getState();
  const [kind, id] = target.split(':');
  const agent = kind === 'agent' ? s.agents.find((a) => a.id === id) : s.agents.find((a) => a.id === s.teams.find((t) => t.id === id)?.agentIds[0]);
  const tpl = TEMPLATES.find((t) => t.id === agent?.template);
  return tpl ? `e.g. ${tpl.example}` : 'Describe an outcome…';
}

function runCard(r) {
  const open = expanded.has(r.id) || r.status === 'awaiting_approval' || r.status === 'running';
  const needs = r.status === 'awaiting_approval';
  return `
  <article class="run ${esc(r.status)}">
    <button class="run-head" data-action="toggle-run" data-id="${r.id}" aria-expanded="${open}">
      <span class="status-pill ${esc(r.status)}">${statusLabel[r.status]}${r.steps.some(s => s.mode === 'demo') ? ' · demo' : ''}</span>
      <span class="run-title">${esc(r.title)}</span>
      <span class="muted small">${ago(r.createdAt)}</span>
    </button>
    ${open ? `
    <div class="run-body">
      <p class="run-task">${esc(r.task)}</p>
      <ol class="steps">
        ${r.steps.map((st) => `
        <li class="step ${esc(st.status)}">
          <div class="step-head"><strong>${esc(st.name)}</strong>
            <span class="muted small">${statusLabel[st.status]}${st.mode === 'demo' ? ' · demo' : st.mode === 'live' ? ' · live' : ''}</span></div>
          ${st.status === 'running' ? '<div class="typing" aria-label="Working"><span></span><span></span><span></span></div>' : ''}
          ${st.output ? `<div class="prose">${md(st.output)}</div>` : ''}
        </li>`).join('')}
      </ol>
      ${r.error ? `<p class="error small">${esc(r.error)}</p>` : ''}
      ${needs ? `<div class="approval row gap"><span class="small">This agent asks for your approval before continuing.</span>
        <button class="btn primary sm" data-action="approve" data-id="${r.id}">Approve</button>
        <button class="btn sm" data-action="reject" data-id="${r.id}">Reject</button></div>` : ''}
    </div>` : ''}
  </article>`;
}

export function render() {
  resolveTarget();
  const s = getState();
  const p = plan();
  const used = s.wallet.creditsUsed;
  const pct = Math.min(100, (used / p.credits) * 100);
  const approvals = s.runs.filter((r) => r.status === 'awaiting_approval');
  const active = s.runs.filter((r) => r.status === 'running').length;
  const scheduled = s.agents.filter((a) => a.schedule !== 'none');
  const live = isLive();

  return `
  <section class="hero">
    <h1 class="hero-title">What should your agents do?</h1>
    <p class="small muted" role="status">${live === true ? 'Live AI drafts. App connections are simulated; external actions and contribution rewards are not verified.' : live === false ? 'Demo mode: outputs and connections are simulated. Tasks do not earn tokens.' : 'Checking AI availability…'}</p>
    <form id="run-form" class="composer">
      <textarea name="task" rows="2" maxlength="6000" required placeholder="${esc(exampleFor())}" aria-label="Task">${esc(taskDraft)}</textarea>
      <div class="composer-bar">
        <select name="target" aria-label="Agent or team" class="pill-select">
          ${s.agents.length ? `<optgroup label="Agents">${s.agents.map((a) => `<option value="agent:${a.id}" ${target === `agent:${a.id}` ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</optgroup>` : ''}
          ${s.teams.length ? `<optgroup label="Teams">${s.teams.map((t) => `<option value="team:${t.id}" ${target === `team:${t.id}` ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup>` : ''}
        </select>
        <span class="muted small mode">${live === true ? 'Live · Claude' : live === false ? 'Demo mode' : ''}</span>
        <button class="send" type="submit" aria-label="Run task" ${s.agents.length ? '' : 'disabled'}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </form>
    ${s.agents.length ? '' : '<p class="small muted center">Create an agent in <a href="#/studio">Agent Studio</a> first.</p>'}
  </section>

  <div class="stats">
    <div class="stat"><span class="stat-n">${active}</span><span class="muted small">Running</span></div>
    <div class="stat"><span class="stat-n">${approvals.length}</span><span class="muted small">Awaiting approval</span></div>
    <div class="stat"><span class="stat-n">${scheduled.length}</span><span class="muted small">Scheduled</span></div>
    <div class="stat wide">
      <div class="row between"><span class="muted small">AI credits this month</span><span class="small">${fmt(used)} / ${fmt(p.credits)}</span></div>
      <div class="meter" role="progressbar" aria-valuenow="${used}" aria-valuemin="0" aria-valuemax="${p.credits}"><span style="width:${pct}%"></span></div>
      <span class="muted small">${REWARD_RULES.creditsPerRun} credits per agent step · ${p.label} plan</span>
    </div>
  </div>

  <section>
    <div class="row between section-row"><h2>Activity</h2>
      ${s.runs.some((r) => ['completed', 'failed', 'rejected'].includes(r.status)) ? '<button class="btn ghost sm" data-action="clear">Clear finished</button>' : ''}</div>
    <div class="runs">${s.runs.map(runCard).join('') || '<p class="muted small">No runs yet. Give an agent a task above.</p>'}</div>
  </section>

  ${scheduled.length ? `
  <section class="panel">
    <div class="panel-head"><h2>Schedules</h2><span class="tag">simulated</span></div>
    <ul class="list">${scheduled.map((a) => `
      <li class="list-row"><div class="list-main"><div><strong>${esc(a.name)}</strong><p class="muted small">Runs ${esc(a.schedule)}</p></div></div>
      <a class="btn sm" href="#/command?agent=${a.id}">Run now</a></li>`).join('')}</ul>
  </section>` : ''}`;
}

export function bind(root, rerender) {
  root.addEventListener('input', (e) => {
    if (e.target.name === 'task') {
      taskDraft = e.target.value;
      e.target.style.height = 'auto';
      e.target.style.height = `${Math.min(e.target.scrollHeight, 240)}px`;
    }
  });
  root.addEventListener('change', (e) => {
    if (e.target.name === 'target') { target = e.target.value; history.replaceState(null, '', '#/command'); rerender(); }
  });
  root.addEventListener('keydown', (e) => {
    if (e.target.name === 'task' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.target.form.requestSubmit();
    }
  });
  root.addEventListener('submit', (e) => {
    if (e.target.id !== 'run-form') return;
    e.preventDefault();
    const fd = new FormData(e.target);
    const task = String(fd.get('task')).trim();
    if (!task) return;
    const s = getState();
    const [kind, id] = String(fd.get('target')).split(':');
    const agentIds = kind === 'team' ? (s.teams.find((t) => t.id === id)?.agentIds || []) : [id];
    const title = kind === 'team' ? s.teams.find((t) => t.id === id)?.name : undefined;
    const res = startRun({ task, agentIds, title });
    if (res.error) { toast(res.error); return; }
    taskDraft = '';
    rerender();
  });
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id } = el.dataset;
    if (action === 'toggle-run') { expanded.has(id) ? expanded.delete(id) : expanded.add(id); rerender(); }
    else if (action === 'approve') approve(id);
    else if (action === 'reject') reject(id);
    else if (action === 'clear') clearFinished();
  });
}

