// Automations: agent tasks that run on a schedule on the server (Cloudflare cron),
// even while this page is closed. Results are kept (last 10 per automation).
import { getState } from '../store.js';
import { esc, md, toast } from '../ui.js';
import { MODES, PERSONALITIES } from '../grok.js';

let list = null;     // null = loading
let error = '';
let busy = new Set();
let open = null;     // automation id whose results are expanded
let rerenderRef = () => {};

async function api(path = '', opts = {}) {
  const res = await fetch(`api/automations${path}`, { headers: { 'content-type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
async function refresh() {
  try { list = (await api()).automations; error = ''; } catch (e) { error = e.message; list = list || []; }
  rerenderRef();
}

const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const EVERY = { hour: 'Every hour', day: 'Every day', week: 'Every week' };

function card(a) {
  const last = a.runs?.[0];
  const running = busy.has(a.id);
  return `
  <article class="card auto-card">
    <div class="row between wrap gap">
      <div>
        <h3>${esc(a.name)}</h3>
        <p class="small muted">${EVERY[a.every]}${a.every !== 'hour' ? ` at ${String(a.hour).padStart(2, '0')}:00 UTC` : ''} · ${esc(a.agent?.name || 'Agent')} · ${esc(MODES.find((m) => m.id === a.mode)?.label || 'Auto')}</p>
        <p class="small">Next run: ${a.enabled ? when(a.next) : 'paused'} · Last run: ${last ? `${when(last.at)} ${last.ok ? '✓' : '✗'}` : 'never'}</p>
      </div>
      <div class="row gap wrap">
        <label class="switch"><input type="checkbox" data-a="toggle" data-id="${a.id}" ${a.enabled ? 'checked' : ''} aria-label="Enabled"> <span class="small">${a.enabled ? 'On' : 'Paused'}</span></label>
        <button class="btn sm" data-a="run" data-id="${a.id}" ${running ? 'disabled' : ''}>${running ? 'Running…' : 'Run now'}</button>
        <button class="btn sm" data-a="open" data-id="${a.id}" aria-expanded="${open === a.id}">${open === a.id ? 'Hide results' : `Results (${a.runs?.length || 0})`}</button>
        <button class="btn sm danger" data-a="delete" data-id="${a.id}" aria-label="Delete ${esc(a.name)}">Delete</button>
      </div>
    </div>
    <details class="small"><summary>Task</summary><p>${esc(a.task)}</p></details>
    ${open === a.id ? `<div class="auto-results">${(a.runs || []).map((r) => `
      <div class="auto-run ${r.ok ? '' : 'failed'}">
        <p class="small muted">${when(r.at)}${r.ok ? '' : ' · failed'}</p>
        ${r.ok ? `<div class="prose">${md(r.output)}</div>` : `<p class="error small">${esc(r.error)}</p>`}
        ${(r.shots || []).map((s) => `<img class="shot" src="${s.image}" alt="Browser: ${esc(s.title || s.url)}" loading="lazy">`).join('')}
      </div>`).join('') || '<p class="small muted">No results yet. Use Run now to try it.</p>'}</div>` : ''}
  </article>`;
}

export function render() {
  const s = getState();
  return `
  <section class="page">
    <h1>Automations</h1>
    <p class="muted">Agents that work on a schedule, even while this page is closed. Checked every 15 minutes.</p>
    <form id="auto-form" class="card stack">
      <label>Task <textarea name="task" rows="2" maxlength="6000" required placeholder="e.g. Every morning, summarize the top AI news with sources"></textarea></label>
      <div class="row gap wrap">
        <label>Agent <select name="agent">${s.agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></label>
        <label>Mode <select name="mode">${MODES.filter((m) => m.id !== 'imagine').map((m) => `<option value="${m.id}" ${m.id === 'deepsearch' ? 'selected' : ''}>${m.label}</option>`).join('')}</select></label>
        <label>Personality <select name="personality">${PERSONALITIES.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}</select></label>
        <label>Repeat <select name="every"><option value="hour">Every hour</option><option value="day" selected>Every day</option><option value="week">Every week</option></select></label>
        <label>At (UTC) <select name="hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === 9 ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></label>
      </div>
      <div><button class="btn primary" type="submit">Create automation</button></div>
    </form>
    ${error ? `<p class="error small">${esc(error)}</p>` : ''}
    ${list === null ? '<p class="muted">Loading…</p>' : list.length ? list.map(card).join('') : '<p class="muted">No automations yet.</p>'}
  </section>`;
}

export function bind(root, rerender) {
  rerenderRef = rerender;
  refresh();
  root.addEventListener('submit', async (e) => {
    if (e.target.id !== 'auto-form') return;
    e.preventDefault();
    const fd = new FormData(e.target);
    const agent = getState().agents.find((a) => a.id === fd.get('agent')) || {};
    try {
      await api('', { method: 'POST', body: JSON.stringify({
        task: String(fd.get('task')).trim(), name: String(fd.get('task')).trim().slice(0, 80),
        mode: fd.get('mode'), personality: fd.get('personality'), every: fd.get('every'), hour: Number(fd.get('hour')),
        agent: { name: agent.name, role: agent.role, instructions: agent.instructions },
      }) });
      toast('Automation created');
      refresh();
    } catch (err) { toast(err.message); }
  });
  root.addEventListener('change', async (e) => {
    if (e.target.dataset.a !== 'toggle') return;
    try { await api(`/${e.target.dataset.id}`, { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) }); refresh(); } catch (err) { toast(err.message); }
  });
  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-a]');
    if (!el || el.dataset.a === 'toggle') return;
    const id = el.dataset.id;
    if (el.dataset.a === 'open') { open = open === id ? null : id; rerender(); }
    else if (el.dataset.a === 'delete') {
      if (!window.confirm('Delete this automation and its results?')) return;
      try { await api(`/${id}`, { method: 'DELETE' }); toast('Deleted'); refresh(); } catch (err) { toast(err.message); }
    } else if (el.dataset.a === 'run') {
      busy.add(id); rerender();
      try { await api(`/${id}/run`, { method: 'POST' }); open = id; } catch (err) { toast(err.message); }
      busy.delete(id); refresh();
    }
  });
}
