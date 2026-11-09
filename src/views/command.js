import { getState } from '../store.js';
import { TEMPLATES } from '../data.js';
import { startRun, approve, reject, stopRun, isLive, mediaFor } from '../runner.js';
import { MODES, PERSONALITIES, composerExtras, bindExtras, takeAttachments, attachState, shareRun, speak, createAutomation } from '../grok.js';
import { esc, md, statusLabel, toast } from '../ui.js';
import { setDraft } from '../forecaster.js';

let target = null;   // "agent:<id>" | "team:<id>"
let taskDraft = '';

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

const selectedRun = () => {
  const id = new URLSearchParams(location.hash.split('?')[1] || '').get('run');
  return id ? getState().runs.find((r) => r.id === id) || null : null;
};

const ICON = {
  send: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="6" y="6" width="12" height="12" fill="currentColor"/></svg>',
};

function message(r, st, i) {
  const busy = st.status === 'running';
  const label = st.status === 'done' ? '' : statusLabel[st.status];
  const tools = st.output && !busy ? `
    <div class="msg-tools">
      <button class="tool" data-action="copy" data-id="${r.id}" data-step="${i}" aria-label="Copy ${esc(st.name)}'s answer">Copy</button>
      <button class="tool" data-action="speak" data-id="${r.id}" data-step="${i}" aria-label="Read ${esc(st.name)}'s answer aloud">Read aloud</button>
      ${r.private ? '' : `<button class="tool" data-action="share" data-id="${r.id}" aria-label="Create a share link for this chat">Share</button>`}
      <button class="tool" data-action="automate" data-id="${r.id}" aria-label="Run this task on a schedule">Automate</button>
      ${st.status === 'done' ? `<button class="tool" data-action="forecast" data-id="${r.id}" data-step="${i}" aria-label="Forecast reactions to ${esc(st.name)}'s answer">Forecast this</button>` : ''}
    </div>` : '';
  return `
  <div class="msg agent ${esc(st.status)}">
    <div class="who">${esc(st.name)}${label ? ` <span class="muted">· ${esc(label)}</span>` : ''}${st.mode === 'demo' ? ' <span class="muted">· demo</span>' : ''}</div>
    ${busy && !st.output ? '<div class="typing" aria-label="Working"><span></span><span></span><span></span></div>' : ''}
    ${st.thinking ? `<details class="thinking"><summary>Thought process</summary><div class="prose small">${md(st.thinking)}</div></details>` : ''}
    ${media(r, i, st)}
    ${st.output ? `<div class="prose${busy ? ' streaming' : ''}" ${busy ? 'aria-live="polite" aria-busy="true"' : ''}>${md(st.output)}</div>` : ''}
    ${tools}
  </div>`;
}

function media(r, i, st) {
  const m = mediaFor(r.id, i);
  const img = m.image ? `<figure class="gen-image"><img src="${m.image}" alt="Generated image"><figcaption><a class="tool" href="${m.image}" download="scalvs-image.jpg">Download</a></figcaption></figure>` : (st.hasImage ? '<p class="small muted">Generated image (not kept after reload).</p>' : '');
  const shots = (m.shots || []).length ? `<div class="shots" aria-label="Browser screenshots">${m.shots.map((x, k) => `<figure><img src="${x.image}" alt="Browser step ${k + 1}: ${esc(x.title || x.url)}" loading="lazy"><figcaption class="small muted">${k + 1}. ${esc(x.title || x.url)}</figcaption></figure>`).join('')}</div>` : (st.shotCount ? `<p class="small muted">${st.shotCount} browser screenshots (not kept after reload).</p>` : '');
  return img + shots;
}

function thread(r) {
  return `
  <div class="thread">
    ${r.private ? '<p class="small muted center">Private chat: not saved after you leave this page, never shared.</p>' : ''}
    <div class="msg user"><div class="bubble">${r.kind ? `<span class="mode-tag">${esc(MODES.find((x) => x.id === r.kind)?.label || r.kind)}</span> ` : ''}${esc(r.task)}${r.attached?.length ? `<div class="small muted">Attached: ${r.attached.map(esc).join(', ')}</div>` : ''}</div></div>
    ${r.steps.map((st, i) => (st.status === 'queued' ? `<div class="msg agent queued"><div class="who">${esc(st.name)} <span class="muted">· Up next</span></div></div>` : message(r, st, i))).join('')}
    ${r.error ? `<p class="error small">${esc(r.error)}</p>` : ''}
    ${r.status === 'awaiting_approval' ? `
    <div class="approval">
      <span class="small">${esc(r.steps[r.current]?.name || 'This agent')} asks for your approval before continuing.</span>
      <div class="row gap"><button class="btn primary sm" data-action="approve" data-id="${r.id}">Approve</button>
      <button class="btn sm" data-action="reject" data-id="${r.id}">Reject</button></div>
    </div>` : ''}
  </div>`;
}

function composer(s, running, live) {
  return `
  <form id="run-form" class="composer">
    ${composerExtras('top')}
    <textarea name="task" rows="1" maxlength="6000" required placeholder="Give your agents a task" title="${esc(exampleFor())}" aria-label="Task">${esc(taskDraft)}</textarea>
    <div class="composer-bar">
      <select name="target" aria-label="Agent or team" class="pill-select">
        ${s.agents.length ? `<optgroup label="Agents">${s.agents.map((a) => `<option value="agent:${a.id}" ${target === `agent:${a.id}` ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</optgroup>` : ''}
        ${s.teams.length ? `<optgroup label="Teams">${s.teams.map((t) => `<option value="team:${t.id}" ${target === `team:${t.id}` ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup>` : ''}
      </select>
      ${composerExtras('bar')}
      ${running
        ? `<button class="send" type="button" data-action="stop" data-id="${running.id}" aria-label="Stop task">${ICON.stop}</button>`
        : `<button class="send" type="submit" aria-label="Run task" ${s.agents.length ? '' : 'disabled'}>${ICON.send}</button>`}
    </div>
  </form>
  <p class="fine" role="status">${live === true ? 'Live AI drafts. Connections and rewards are simulated in this prototype.' : live === false ? 'Demo mode. Answers are simulated.' : '&nbsp;'}</p>`;
}

export function render() {
  resolveTarget();
  const s = getState();
  const live = isLive();
  const r = selectedRun();
  const running = r && r.status === 'running' ? r : null;

  if (!r) {
    return `
    <section class="home">
      <h1 class="hero-title">What should your agents do?</h1>
      ${composer(s, null, live)}
      ${s.agents.length ? '' : '<p class="small muted center">Create an agent in <a href="#/studio">Agents</a> first.</p>'}
    </section>`;
  }
  return `
  <section class="chat">
    ${thread(r)}
    <div class="dock">${composer(s, running, live)}</div>
  </section>`;
}

export function bind(root, rerender) {
  bindExtras(root, rerender, (text) => {
    const ta = root.querySelector('textarea[name=task]');
    if (ta) { ta.value = text; taskDraft = text; ta.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  root.addEventListener('input', (e) => {
    if (e.target.name === 'task') {
      taskDraft = e.target.value;
      e.target.style.height = 'auto';
      e.target.style.height = `${Math.min(e.target.scrollHeight, 240)}px`;
    }
  });
  root.addEventListener('change', (e) => {
    if (e.target.name === 'target') { target = e.target.value; rerender(); }
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
    const opts = takeAttachments();
    const res = startRun({ task, agentIds, title, opts });
    if (res.error) { toast(res.error); return; }
    taskDraft = '';
    location.hash = `#/command?run=${res.run.id}`;
  });
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id } = el.dataset;
    if (action === 'approve') approve(id);
    else if (action === 'reject') reject(id);
    else if (action === 'stop') { stopRun(id); toast('Run stopped'); }
    else if (action === 'forecast') {
      const run = getState().runs.find((x) => x.id === id);
      const out = run?.steps[Number(el.dataset.step)]?.output || '';
      setDraft({ seed: out.slice(0, 60000), question: `How will people react to this, and what happens next? (${run.task.slice(0, 160)})`, product: 'SCALVS.ai' });
      location.hash = '#/forecast';
    }
    else if (action === 'speak') {
      const run = getState().runs.find((x) => x.id === id);
      speak(run?.steps[Number(el.dataset.step)]?.output || '');
    }
    else if (action === 'share') {
      const run = getState().runs.find((x) => x.id === id);
      if (run) shareRun(run);
    }
    else if (action === 'automate') {
      const run = getState().runs.find((x) => x.id === id);
      if (run) createAutomation(run);
    }
    else if (action === 'copy') {
      const run = getState().runs.find((x) => x.id === id);
      const text = run?.steps[Number(el.dataset.step)]?.output || '';
      navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Copy failed'));
    }
  });
}

