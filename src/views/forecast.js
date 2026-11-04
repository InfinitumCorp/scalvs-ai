import { getState } from '../store.js';
import { FORECAST_PRESETS, REWARD_RULES } from '../data.js';
import {
  STAGES, stageIndex, startForecast, stopForecast, askReportAgent, clearFinishedForecasts,
  isForecastLive, takeDraft,
} from '../forecaster.js';
import { esc, md, ago, fmt, toast } from '../ui.js';

const form = { product: 'SCALVS.ai', question: '', seed: '', rounds: '20', platform: 'parallel', vault: true };
const chatDrafts = {};
const toggled = new Set();
let busy = false;

const STATUS = { running: 'Running', completed: 'Completed', failed: 'Failed', stopped: 'Stopped' };

function vaultText() {
  return getState().vault.filter((m) => m.products.includes('SCALVS.ai')).map((m) => `- ${m.text}`).join('\n');
}

function stages(job) {
  const at = stageIndex(job.step);
  return `<ol class="fc-stages">${STAGES.map((s, i) => {
    const state = job.status === 'completed' || i < at ? 'done' : i === at ? (job.status === 'running' ? 'now' : job.status) : 'todo';
    return `<li class="fc-stage ${state}"><span class="fc-dot" aria-hidden="true"></span>${esc(s.label)}<span class="sr-only"> (${state})</span></li>`;
  }).join('')}</ol>`;
}

function card(f, index) {
  const j = f.job;
  const open = (index === 0) !== toggled.has(f.id) || j.status === 'running';
  return `
  <article class="run ${esc(j.status)}">
    <button class="run-head" data-action="toggle" data-id="${f.id}" aria-expanded="${open}">
      <span class="status-pill ${esc(j.status)}">${STATUS[j.status] || esc(j.status)}${f.mode === 'demo' ? ' · demo' : ''}</span>
      <span class="tag">${esc(j.product)}</span>
      <span class="run-title">${esc(j.title)}</span>
      <span class="muted small">${ago(f.createdAt)}</span>
    </button>
    ${open ? `
    <div class="run-body">
      <p class="run-task">${esc(j.question)}</p>
      <div class="meter" role="progressbar" aria-label="Forecast progress" aria-valuenow="${j.progress}" aria-valuemin="0" aria-valuemax="100"><span style="width:${j.progress}%"></span></div>
      ${stages(j)}
      <p class="small muted" ${j.status === 'running' ? 'role="status"' : ''}>${esc(j.message || '')}${j.stats?.actions != null ? ` · ${fmt(j.stats.actions)} agent actions simulated` : ''}</p>
      ${j.error ? `<p class="error small">${esc(j.error)}</p>` : ''}
      ${j.status === 'running' ? `<div class="row"><button class="btn sm" data-action="stop" data-id="${f.id}">Stop</button></div>` : ''}
      ${j.report ? `
      <div class="fc-report">
        <div class="row between"><h3>Forecast report</h3><button class="btn ghost sm" data-action="copy" data-id="${f.id}">Copy report</button></div>
        <div class="prose">${md(j.report)}</div>
      </div>` : ''}
      ${j.status === 'completed' ? `
      <div class="fc-chat">
        <h3>Ask the ReportAgent</h3>
        ${f.chat.map((m) => `<div class="fc-msg ${m.role}">${m.role === 'user' ? esc(m.content) : `<div class="prose">${md(m.content)}</div>`}</div>`).join('')}
        ${f.asking ? '<div class="typing" aria-label="ReportAgent is answering"><span></span><span></span><span></span></div>' : ''}
        <form class="row gap inline-form" data-form="chat" data-id="${f.id}">
          <input name="chat-${f.id}" maxlength="2000" value="${esc(chatDrafts[f.id] || '')}" placeholder="Why did sentiment turn? Which group drove it?" aria-label="Question for the ReportAgent" ${f.asking ? 'disabled' : ''}>
          <button class="btn primary" type="submit" ${f.asking ? 'disabled' : ''}>Ask</button>
        </form>
      </div>` : ''}
    </div>` : ''}
  </article>`;
}

export function render() {
  const d = takeDraft();
  if (d) Object.assign(form, d);
  const s = getState();
  const live = isForecastLive();
  const cost = REWARD_RULES.creditsPerForecast;
  return `
  <header class="page-head">
    <p class="eyebrow">Predict</p>
    <h1>Forecast what happens next</h1>
    <p class="lede">Give the swarm your material and a question. Hundreds of persona agents react to it on simulated social platforms, and a ReportAgent turns what they did into a forecast.</p>
    <p class="small muted" role="status">${live === true ? 'Live: powered by the MiroFish swarm-intelligence engine. Forecasts are simulations of likely reactions, not guarantees.' : live === false ? 'Demo mode: no simulation runs and reports are placeholders. Set MIROFISH_URL to connect a MiroFish engine.' : 'Checking forecasting engine…'}</p>
  </header>

  <section class="panel">
    <div class="panel-head"><h2>New forecast</h2><span class="tag">${cost} AI credits</span></div>
    <form id="fc-form" class="form">
      <div>
        <span class="label">Use case</span>
        <div class="chips">${FORECAST_PRESETS.map((p) => `<button type="button" class="chip ${form.product === p.product ? 'sel' : ''}" data-action="preset" data-product="${esc(p.product)}" aria-pressed="${form.product === p.product}">${esc(p.product)} · ${esc(p.label)}</button>`).join('')}</div>
      </div>
      <label>What do you want to predict?
        <textarea name="question" rows="2" maxlength="2000" required>${esc(form.question)}</textarea>
      </label>
      <label>Seed material
        <textarea name="seed" rows="7" maxlength="60000" required placeholder="Paste the news, plan, announcement, customer notes or data the agents should react to.">${esc(form.seed)}</textarea>
        <span class="muted tiny">${fmt(form.seed.length)} / 60,000 characters</span>
      </label>
      <div class="row gap">
        <label class="inline">Rounds
          <select name="rounds">${['10', '20', '40'].map((r) => `<option ${form.rounds === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
        </label>
        <label class="inline">Platforms
          <select name="platform">
            <option value="parallel" ${form.platform === 'parallel' ? 'selected' : ''}>Twitter + Reddit style</option>
            <option value="twitter" ${form.platform === 'twitter' ? 'selected' : ''}>Twitter style</option>
            <option value="reddit" ${form.platform === 'reddit' ? 'selected' : ''}>Reddit style</option>
          </select>
        </label>
        <label class="check"><input type="checkbox" name="vault" ${form.vault ? 'checked' : ''}> Add Context Vault</label>
      </div>
      <div class="row gap"><button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Starting…' : 'Run forecast'}</button>
        <span class="muted small">Live runs take minutes to hours, depending on the material and the number of rounds.</span></div>
    </form>
  </section>

  <div class="row between section-row"><h2 class="section-title">Forecasts</h2>
    ${s.forecasts.some((f) => f.job.status !== 'running') ? '<button class="btn ghost sm" data-action="clear">Clear finished</button>' : ''}</div>
  <div class="runs">${s.forecasts.map(card).join('') || '<p class="muted small">No forecasts yet. Pick a use case above, or use “Forecast this” on any agent result.</p>'}</div>`;
}

export function bind(root, rerender) {
  root.addEventListener('input', (e) => {
    const { name, value, type, checked } = e.target;
    if (name === 'question' || name === 'seed' || name === 'rounds' || name === 'platform') form[name] = value;
    else if (name === 'vault' && type === 'checkbox') form.vault = checked;
    else if (name?.startsWith('chat-')) chatDrafts[name.slice(5)] = value;
    if (name === 'seed') {
      const counter = e.target.parentElement.querySelector('.tiny');
      if (counter) counter.textContent = `${fmt(value.length)} / 60,000 characters`;
    }
  });
  root.addEventListener('change', (e) => {
    if (e.target.name === 'vault') form.vault = e.target.checked;
    if (e.target.name === 'rounds' || e.target.name === 'platform') form[e.target.name] = e.target.value;
  });

  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id } = el.dataset;
    if (action === 'preset') {
      const p = FORECAST_PRESETS.find((x) => x.product === el.dataset.product);
      form.product = p.product;
      if (!form.question.trim() || FORECAST_PRESETS.some((x) => x.question === form.question)) form.question = p.question;
      rerender();
    } else if (action === 'toggle') {
      toggled.has(id) ? toggled.delete(id) : toggled.add(id);
      rerender();
    } else if (action === 'stop') {
      await stopForecast(id);
      toast('Forecast stopped');
    } else if (action === 'copy') {
      const f = getState().forecasts.find((x) => x.id === id);
      navigator.clipboard?.writeText(f?.job.report || '').then(() => toast('Copied'), () => toast('Copy failed'));
    } else if (action === 'clear') {
      clearFinishedForecasts();
    }
  });

  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id === 'fc-form') {
      if (busy) return;
      const vault = form.vault ? vaultText() : '';
      const seed = vault ? `${form.seed.trim()}\n\n## Organization context (Nexus Context Vault)\n${vault}` : form.seed;
      busy = true;
      rerender();
      const result = await startForecast({
        question: form.question, seed, rounds: Number(form.rounds), platform: form.platform, product: form.product,
      });
      busy = false;
      if (result.error) { rerender(); toast(result.error); return; }
      form.question = '';
      form.seed = '';
      toast(result.forecast.mode === 'live' ? 'Forecast started' : 'Demo forecast started');
      rerender();
    } else if (e.target.dataset.form === 'chat') {
      const id = e.target.dataset.id;
      const msg = (chatDrafts[id] || '').trim();
      if (!msg) return;
      chatDrafts[id] = '';
      const r = await askReportAgent(id, msg);
      if (r.error) { chatDrafts[id] = msg; toast(r.error); rerender(); }
    }
  });
}
