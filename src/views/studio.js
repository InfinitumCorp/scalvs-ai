import { getState, update, uid, plan } from '../store.js';
import { TEMPLATES, ALL_TOOLS } from '../data.js';
import { esc, toast } from '../ui.js';

let draft = null;       // agent being created/edited
let teamDraft = null;   // { name, agentIds: [] }

const tplOf = (id) => TEMPLATES.find((t) => t.id === id) || TEMPLATES[0];

function agentCard(a) {
  const t = tplOf(a.template);
  return `
  <article class="card agent">
    <div class="agent-head">
      <span class="glyph" aria-hidden="true">${t.glyph}</span>
      <div>
        <h3>${esc(a.name)}</h3>
        <p class="muted small">${esc(t.name)}${a.schedule !== 'none' ? ` · runs ${esc(a.schedule)}` : ''}</p>
      </div>
    </div>
    <p class="small">${esc(a.role)}</p>
    <div class="chips">${a.tools.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>
    <div class="flags small">
      <span class="${a.memory ? 'on' : ''}">● Context Vault ${a.memory ? 'on' : 'off'}</span>
      <span class="${a.approval ? 'on' : ''}">● Approval ${a.approval ? 'required' : 'not required'}</span>
    </div>
    <div class="row gap">
      <a class="btn primary sm" href="#/command?agent=${a.id}">Run</a>
      <button class="btn sm" data-action="edit-agent" data-id="${a.id}">Edit</button>
      <button class="btn ghost sm" data-action="delete-agent" data-id="${a.id}" aria-label="Delete ${esc(a.name)}">Delete</button>
    </div>
  </article>`;
}

function editor() {
  if (!draft) return '';
  const t = tplOf(draft.template);
  return `
  <section class="panel editor" aria-label="Agent editor">
    <div class="panel-head">
      <h2>${draft.id ? `Edit ${esc(draft.name)}` : `New ${esc(t.name)} agent`}</h2>
      <button class="btn ghost sm" data-action="close-editor">Cancel</button>
    </div>
    <form id="agent-form" class="form">
      <label>Name<input name="name" required maxlength="40" value="${esc(draft.name)}" placeholder="e.g. Atlas"></label>
      <label>Role<input name="role" required maxlength="200" value="${esc(draft.role)}"></label>
      <label>Instructions<textarea name="instructions" rows="3" maxlength="2000" placeholder="How should this agent work? Tone, rules, sources…">${esc(draft.instructions)}</textarea></label>
      <fieldset>
        <legend>Tools</legend>
        <div class="checks">
          ${ALL_TOOLS.map((tool) => `<label class="check"><input type="checkbox" name="tools" value="${esc(tool)}" ${draft.tools.includes(tool) ? 'checked' : ''}> ${esc(tool)}</label>`).join('')}
        </div>
      </fieldset>
      <div class="grid2">
        <label class="check"><input type="checkbox" name="memory" ${draft.memory ? 'checked' : ''}> Use the Nexus Context Vault</label>
        <label class="check"><input type="checkbox" name="approval" ${draft.approval ? 'checked' : ''}> Require my approval before finishing</label>
      </div>
      <label>Schedule
        <select name="schedule">
          ${['none', 'hourly', 'daily', 'weekly'].map((s) => `<option value="${s}" ${draft.schedule === s ? 'selected' : ''}>${s === 'none' ? 'On demand' : s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
        </select>
      </label>
      <div class="row gap"><button class="btn primary" type="submit">${draft.id ? 'Save changes' : 'Create agent'}</button></div>
    </form>
  </section>`;
}

function teams() {
  const s = getState();
  const byId = Object.fromEntries(s.agents.map((a) => [a.id, a]));
  const list = s.teams.map((tm) => `
    <li class="team">
      <div><strong>${esc(tm.name)}</strong>
      <span class="muted small">${tm.agentIds.map((id) => esc(byId[id]?.name || 'deleted')).join(' → ')}</span></div>
      <div class="row gap">
        <a class="btn sm primary" href="#/command?team=${tm.id}">Run</a>
        <button class="btn ghost sm" data-action="delete-team" data-id="${tm.id}">Delete</button>
      </div>
    </li>`).join('');

  const builder = teamDraft ? `
    <form id="team-form" class="form team-builder">
      <label>Team name<input name="name" required maxlength="40" value="${esc(teamDraft.name)}" placeholder="e.g. Research → Draft"></label>
      <p class="small muted">Pick agents in the order /CNDCTR/ should run them. Each one builds on the previous output.</p>
      <div class="chips pick">${s.agents.map((a) => {
        const pos = teamDraft.agentIds.indexOf(a.id);
        return `<button type="button" class="chip ${pos >= 0 ? 'sel' : ''}" data-action="team-toggle" data-id="${a.id}">${pos >= 0 ? `${pos + 1}. ` : ''}${esc(a.name)}</button>`;
      }).join('')}</div>
      <div class="row gap"><button class="btn primary" type="submit">Save team</button><button type="button" class="btn ghost" data-action="team-cancel">Cancel</button></div>
    </form>` : `<button class="btn" data-action="team-new" ${s.agents.length < 2 ? 'disabled' : ''}>New team</button>`;

  return `
  <section class="panel">
    <div class="panel-head"><h2>Teams of agents</h2><span class="tag">coordinated by /CNDCTR/</span></div>
    ${s.teams.length ? `<ul class="teams">${list}</ul>` : '<p class="muted small">No teams yet. Chain two or more agents so they plan, act and verify together.</p>'}
    ${builder}
  </section>`;
}

export function render() {
  const s = getState();
  const p = plan();
  const atLimit = s.agents.length >= p.agents;
  return `
  <header class="page-head">
    <p class="eyebrow">01 / Create</p>
    <h1>Agent Studio</h1>
    <p class="lede">Build agents from templates, assign tools and memory.</p>
  </header>

  <section class="panel">
    <div class="panel-head">
      <h2>Start from a template</h2>
      <span class="tag ${atLimit ? 'warn' : ''}">${s.agents.length} / ${p.agents} active agents · ${p.label}</span>
    </div>
    <div class="templates">
      ${TEMPLATES.map((t) => `
        <button class="tpl" data-action="new-agent" data-id="${t.id}" ${atLimit ? 'disabled' : ''}>
          <span class="glyph" aria-hidden="true">${t.glyph}</span>
          <span class="tpl-name">${t.name}</span>
          <span class="small muted">${esc(t.tools.join(' · '))}</span>
        </button>`).join('')}
    </div>
    ${atLimit ? `<p class="small warn-text">You've reached the ${p.label} plan limit. <a href="#/earnings">Change plan</a> to add more agents.</p>` : ''}
  </section>

  ${editor()}

  <section>
    <h2 class="section-title">Your agents</h2>
    <div class="cards">${s.agents.map(agentCard).join('') || '<p class="muted">No agents yet.</p>'}</div>
  </section>

  ${teams()}`;
}

export function bind(root, rerender) {
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id } = el.dataset;
    const s = getState();
    if (action === 'new-agent') {
      const t = tplOf(id);
      draft = { template: t.id, name: '', role: t.role, instructions: '', tools: [...t.tools], memory: true, approval: t.id === 'sales', schedule: 'none' };
      rerender();
      root.querySelector('#agent-form input[name=name]')?.focus();
    } else if (action === 'edit-agent') {
      draft = structuredClone(s.agents.find((a) => a.id === id));
      rerender();
      root.querySelector('.editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (action === 'close-editor') {
      draft = null; rerender();
    } else if (action === 'delete-agent') {
      const a = s.agents.find((x) => x.id === id);
      if (a && confirm(`Delete ${a.name}? Teams using it will skip it.`)) {
        update((st) => { st.agents = st.agents.filter((x) => x.id !== id); });
        toast(`${a.name} deleted`);
      }
    } else if (action === 'team-new') {
      teamDraft = { name: '', agentIds: [] }; rerender();
    } else if (action === 'team-cancel') {
      teamDraft = null; rerender();
    } else if (action === 'team-toggle') {
      const i = teamDraft.agentIds.indexOf(id);
      if (i >= 0) teamDraft.agentIds.splice(i, 1); else teamDraft.agentIds.push(id);
      teamDraft.name = root.querySelector('#team-form input[name=name]')?.value ?? teamDraft.name;
      rerender();
    } else if (action === 'delete-team') {
      update((st) => { st.teams = st.teams.filter((t) => t.id !== id); });
    }
  });

  root.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    if (form.id === 'agent-form') {
      const data = {
        ...draft,
        name: fd.get('name').trim(),
        role: fd.get('role').trim(),
        instructions: fd.get('instructions').trim(),
        tools: fd.getAll('tools'),
        memory: fd.get('memory') === 'on',
        approval: fd.get('approval') === 'on',
        schedule: fd.get('schedule'),
      };
      const isNew = !data.id;
      draft = null;
      update((st) => {
        if (isNew) st.agents.push({ ...data, id: uid('agt'), createdAt: Date.now() });
        else st.agents = st.agents.map((a) => (a.id === data.id ? data : a));
      });
      toast(isNew ? `${data.name} is ready` : 'Changes saved');
    } else if (form.id === 'team-form') {
      if (teamDraft.agentIds.length < 2) { toast('Pick at least two agents'); return; }
      const name = fd.get('name').trim();
      const agentIds = [...teamDraft.agentIds];
      teamDraft = null;
      update((st) => { st.teams.push({ id: uid('team'), name, agentIds }); });
      toast(`Team “${name}” saved`);
    }
  });
}
