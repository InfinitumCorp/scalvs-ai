import { getState, update, subscribe, plan } from './store.js';
import { checkLive, recoverInterrupted } from './runner.js';
import * as command from './views/command.js';
import * as studio from './views/studio.js';
import * as connect from './views/connect.js';
import * as earnings from './views/earnings.js';

const ROUTES = { command, studio, connect, earnings };
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

function renderNav() {
  const s = getState();
  const pending = s.runs.filter((r) => r.status === 'awaiting_approval').length;
  document.querySelectorAll('[data-route]').forEach((a) => {
    const on = a.dataset.route === current;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const badge = document.getElementById('approvals-badge');
  badge.textContent = pending;
  badge.hidden = pending === 0;
  document.getElementById('plan-label').textContent = `${plan().label} plan`;
  document.getElementById('sclv-label').textContent = `${s.wallet.sclv} $SCLV`;
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
    document.body.classList.remove('nav-open');
  }
  renderView();
}

window.addEventListener('hashchange', navigate);
subscribe(() => renderView());

document.getElementById('menu-btn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
document.getElementById('scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));

navigate();
recoverInterrupted();
checkLive().then(() => renderView());
