import { getState, update, subscribe, plan } from './store.js';
import { esc, toast } from './ui.js';
import { readReturn, syncPlan } from './billing.js';
import { checkLive, recoverInterrupted, clearFinished } from './runner.js';
import * as command from './views/command.js';
import * as studio from './views/studio.js';
import * as connect from './views/connect.js';
import * as earnings from './views/earnings.js';
import * as forecast from './views/forecast.js';
import * as automations from './views/automations.js';
import * as shared from './views/shared.js';
import { checkForecastLive, resumeForecasts } from './forecaster.js';

const ROUTES = { command, studio, connect, forecast, earnings, automations, shared };
const main = document.getElementById('main');
let current = null;
let root = null;

// Runs interrupted by a page reload can't resume.
update((st) => {
  st.runs.forEach((r) => {
    if (r.status === 'running') {
      r.status = 'failed';
      r.error = 'Interrupted by a page reload.';
      r.steps.forEach((s) => { if (s.status === 'running' || s.status === 'queued') s.status = 'failed'; });
    }
  });
});

function routeName() {
  const name = location.hash.replace(/^#\/?/, '').split('?')[0];
  return ROUTES[name] ? name : 'command';
}

function renderView() {
  // Keep focus and caret in text fields across re-renders.
  const active = document.activeElement;
  const key = active && root?.contains(active) && active.name ? active.name : null;
  const sel = key && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

  root.innerHTML = ROUTES[current].render();

  if (key) {
    const el = root.querySelector(`[name="${key}"]`);
    if (el) { el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(...sel); } catch { /* noop */ } }
  }
  renderNav();
}

const STATUS_DOT = { running: 'Running', awaiting_approval: 'Needs approval', failed: 'Failed' };

function renderNav() {
  const s = getState();
  const runId = new URLSearchParams(location.hash.split('?')[1] || '').get('run');
  document.querySelectorAll('[data-route]').forEach((a) => {
    const on = a.dataset.route === current || (a.dataset.route === 'new' && current === 'command' && !runId);
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const forecasting = s.forecasts.some((f) => f.job.status === 'running');
  document.getElementById('forecast-badge').hidden = !forecasting;

  // ChatGPT-style history: one line per task, newest first.
  const list = document.getElementById('recent-list');
  list.innerHTML = s.runs.slice(0, 30).map((r) => {
    const flag = STATUS_DOT[r.status];
    const on = r.id === runId && current === 'command';
    return `<li><a href="#/command?run=${r.id}" class="${on ? 'active' : ''}" ${on ? 'aria-current="page"' : ''} title="${esc(r.task)}">
      <span class="recent-title">${esc(r.task)}</span>${flag ? `<span class="dot-badge ${r.status}" role="img" aria-label="${flag}"></span>` : ''}</a></li>`;
  }).join('') || '<li class="muted tiny recent-empty">Your tasks will appear here.</li>';

  document.getElementById('clear-recent').hidden = !s.runs.some((r) => !['running', 'awaiting_approval'].includes(r.status));
  const left = Math.max(0, plan().credits - s.wallet.creditsUsed);
  document.getElementById('plan-label').textContent = `${plan().label} plan · ${left} credits left`;
}

function navigate() {
  const next = routeName();
  if (next !== current || !root) {
    current = next;
    root = document.createElement('div');
    root.className = `view view-${current}`;
    main.replaceChildren(root);
    ROUTES[current].bind(root, renderView);
    window.scrollTo(0, 0);
  }
  document.body.classList.remove('nav-open');
  renderView();
}

window.addEventListener('hashchange', navigate);
subscribe(() => renderView());

document.getElementById('menu-btn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
document.getElementById('clear-recent').addEventListener('click', () => {
  const open = new URLSearchParams(location.hash.split('?')[1] || '').get('run');
  clearFinished();
  if (open && !getState().runs.some((r) => r.id === open)) location.hash = '#/command';
});
document.getElementById('scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));

// Back from Stripe Checkout or the billing portal (?billing=success|cancelled): open Plans and say what happened.
const billingReturn = readReturn(location.search);
if (billingReturn || location.search.includes('session_id=')) {
  history.replaceState(null, '', `${location.pathname}#/earnings`);
  if (billingReturn === 'success') toast('Payment complete. Your plan will update in a moment.');
  else if (billingReturn === 'cancelled') toast('Checkout cancelled. No charge was made.');
}

// The paid plan comes from the revenue API, not from this browser.
async function refreshPlan(attempts = 1) {
  const { billing } = getState();
  if (!billing?.apiKey) return;
  for (let i = 0; i < attempts; i++) {
    try {
      const next = await syncPlan({ billing });
      if (next !== getState().plan) update((st) => { st.plan = next; if (next !== 'free') st.wallet.adsOptIn = false; });
      if (next !== 'free' || i === attempts - 1) return;
    } catch { return; /* offline or API down: keep the last known plan */ }
    await new Promise((r) => setTimeout(r, 2000)); // the Stripe webhook may land a moment after the redirect
  }
}

navigate();
refreshPlan(billingReturn === 'success' ? 5 : 1);
recoverInterrupted();
checkLive().then(() => renderView());
checkForecastLive().then(() => { resumeForecasts(); renderView(); });
