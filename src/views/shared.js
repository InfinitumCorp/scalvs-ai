// Read-only view of a shared chat: #/shared?id=<id>
import { esc, md } from '../ui.js';

let snap = null;
let error = '';
let loadedId = null;

const idFromHash = () => new URLSearchParams(location.hash.split('?')[1] || '').get('id') || '';

let rerenderRef = () => {};

function ensureLoaded() {
  const id = idFromHash();
  if (id === loadedId) return;
  loadedId = id; snap = null; error = '';
  fetch(`api/share?id=${encodeURIComponent(id)}`)
    .then(async (res) => { const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Not found'); snap = data; })
    .catch((e) => { error = e.message || 'Could not load this chat.'; })
    .finally(() => rerenderRef());
}

export function render() {
  ensureLoaded();
  if (error) return `<section class="page"><h1>Shared chat</h1><p class="error">${esc(error)}</p><p><a href="#/command">Start your own task</a></p></section>`;
  if (!snap) return '<section class="page"><p class="muted">Loading shared chat…</p></section>';
  return `
  <section class="chat">
    <p class="small muted center">Shared chat · ${esc(new Date(snap.createdAt).toLocaleDateString())} · read only</p>
    <div class="thread">
      <div class="msg user"><div class="bubble">${esc(snap.task)}</div></div>
      ${snap.steps.map((s) => `<div class="msg agent done"><div class="who">${esc(s.name)}</div><div class="prose">${md(s.output)}</div></div>`).join('')}
    </div>
    <p class="center"><a class="btn primary" href="#/command">Try SCALVS.ai</a></p>
  </section>`;
}

export function bind(_root, rerender) {
  rerenderRef = rerender;
}
