// SCALVS Search: ask anything, get a cited answer from the live web (api/search.js).
// #/search             the search page (new search, or the open thread)
// #/search?t=<id>      a saved thread
//
// Threads live in this browser only (localStorage), like the rest of the app.

import { esc, md, toast } from '../ui.js';

const KEY = 'scalvs.search.v1';
const MAX_THREADS = 20;
const EXAMPLES = [
  'What did the James Webb Space Telescope discover this year?',
  'How does Cloudflare Workers pricing work?',
  'Best open-source alternatives to Perplexity',
  'What changed in the latest Node.js LTS release?',
];
const STAGES = {
  planning: () => 'Planning the searches…',
  searching: (e) => `Searching the web${e.queries?.length > 1 ? ` for ${e.queries.length} queries` : ''}…`,
  reading: (e) => `Reading ${e.count} page${e.count === 1 ? '' : 's'}${e.sites?.length ? `: ${[...new Set(e.sites)].slice(0, 4).join(', ')}` : ''}…`,
  following: (e) => `Following ${e.count} link${e.count === 1 ? '' : 's'} deeper…`,
  writing: (e) => `Writing the answer from ${e.count} source${e.count === 1 ? '' : 's'}…`,
};

let threads = load();
let depth = 'quick';
let draft = '';
let followDraft = '';
let controller = null;
let rerenderRef = () => {};
let frame = 0;

function load() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function save() {
  try {
    const slim = threads.slice(0, MAX_THREADS).map((t) => ({ ...t, turns: t.turns.map(({ running, stage, ...turn }) => turn) }));
    localStorage.setItem(KEY, JSON.stringify(slim));
  } catch { /* storage full or blocked: keep in memory */ }
}
const uid = () => Math.random().toString(36).slice(2, 10);
const threadId = () => new URLSearchParams(location.hash.split('?')[1] || '').get('t');
const current = () => threads.find((t) => t.id === threadId()) || null;
const busy = () => threads.some((t) => t.turns.some((x) => x.running));
const paint = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; rerenderRef(); }); };

// ------------------------------------------------------------------ rendering

const initial = (site) => esc((site || '?').replace(/^www\./, '').charAt(0).toUpperCase());

function cite(html, sources) {
  return html.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g, (m, list) => list.split(/\s*,\s*/).map((n) => {
    const s = sources[Number(n) - 1];
    return s ? `<a class="cite" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(`${s.site} — ${s.title}`)}">${Number(n)}</a>` : '';
  }).join(''));
}

function sourceCards(sources) {
  if (!sources?.length) return '';
  return `
  <div class="sx-sources" role="list" aria-label="Sources">
    ${sources.map((s) => `
    <a class="sx-card" role="listitem" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.title)}">
      <span class="sx-card-top"><span class="sx-fav" aria-hidden="true">${initial(s.site)}</span><span class="sx-site">${esc(s.site)}</span><span class="sx-n">${s.n}</span></span>
      <span class="sx-title">${esc(s.title)}</span>
    </a>`).join('')}
  </div>`;
}

function turnView(t, i, thread) {
  const last = i === thread.turns.length - 1;
  return `
  <article class="sx-turn" aria-busy="${t.running ? 'true' : 'false'}">
    <h2 class="sx-q">${esc(t.q)}</h2>
    ${t.queries?.length > 1 ? `<p class="tiny muted sx-queries">Searched: ${t.queries.map((q) => `<span>${esc(q)}</span>`).join(' · ')}</p>` : ''}
    ${t.sources?.length ? `<h3 class="sx-h">Sources</h3>${sourceCards(t.sources)}` : ''}
    ${t.running && t.stage ? `<p class="small muted sx-stage" role="status"><span class="sx-spin" aria-hidden="true"></span>${esc(t.stage)}</p>` : ''}
    ${t.answer ? `<h3 class="sx-h">Answer</h3><div class="prose sx-answer" translate="no">${cite(md(t.answer), t.sources || [])}</div>` : ''}
    ${t.error ? `<p class="error small" role="alert">${esc(t.error)}</p>` : ''}
    ${!t.running && t.answer ? `
    <div class="row gap sx-actions">
      <button class="btn ghost sm" data-action="copy" data-i="${i}">Copy</button>
      ${t.depth !== 'pro' ? `<button class="btn ghost sm" data-action="pro" data-i="${i}">Search deeper (Pro)</button>` : ''}
      <span class="tiny muted">${t.depth === 'pro' ? 'Pro' : 'Quick'}${t.sources?.length ? ` · ${t.sources.filter((s) => s.read).length} pages read` : ''}${t.ms ? ` · ${(t.ms / 1000).toFixed(1)} s` : ''}</span>
    </div>` : ''}
    ${last && !t.running && t.related?.length ? `
    <h3 class="sx-h">Related</h3>
    <ul class="sx-related">${t.related.map((r) => `<li><button type="button" data-action="ask" data-q="${esc(r)}">${esc(r)}<span aria-hidden="true">+</span></button></li>`).join('')}</ul>` : ''}
  </article>`;
}

function depthToggle(name) {
  return `
  <div class="sx-depth" role="radiogroup" aria-label="Search depth">
    <button type="button" role="radio" aria-checked="${depth === 'quick'}" class="chip ${depth === 'quick' ? 'sel' : ''}" data-action="depth" data-depth="quick" title="One search, reads the top pages">Quick</button>
    <button type="button" role="radio" aria-checked="${depth === 'pro'}" class="chip ${depth === 'pro' ? 'sel' : ''}" data-action="depth" data-depth="pro" title="Plans several searches, reads more pages and follows links">Pro</button>
  </div>`;
}

function box(name, value, placeholder, disabled) {
  return `
  <form class="composer sx-box" data-form="search">
    <label class="sr-only" for="${name}">Search question</label>
    <textarea id="${name}" name="${name}" rows="1" maxlength="500" placeholder="${esc(placeholder)}" ${disabled ? 'disabled' : ''}>${esc(value)}</textarea>
    <div class="composer-bar">
      ${depthToggle(name)}
      ${disabled ? '<button class="btn sm" type="button" data-action="stop">Stop</button>' : `
      <button class="send" type="submit" aria-label="Search"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 16l4.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>`}
    </div>
  </form>`;
}

export function render() {
  const t = current();
  if (!t) {
    return `
    <section class="home sx-home">
      <h1 class="hero-title">Ask the web</h1>
      ${box('sq', draft, 'Ask anything. SCALVS reads the web and cites its sources.', busy())}
      <div class="chips sx-examples">${EXAMPLES.map((q) => `<button class="chip" type="button" data-action="ask" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      ${threads.length ? `
      <div class="sx-recent">
        <div class="row between"><h2 class="sx-h">Recent searches</h2><button class="btn ghost sm" data-action="clear">Clear</button></div>
        <ul>${threads.slice(0, 8).map((x) => `<li><a href="#/search?t=${esc(x.id)}">${esc(x.turns[0]?.q || 'Search')}</a></li>`).join('')}</ul>
      </div>` : ''}
      <p class="tiny muted center sx-note">Answers come from public web pages and can be wrong. Check the cited sources. The crawler respects robots.txt.</p>
    </section>`;
  }
  const running = t.turns.some((x) => x.running);
  return `
  <section class="chat sx-thread">
    <div class="row between sx-top"><a class="btn ghost sm" href="#/search">New search</a></div>
    ${t.turns.map((turn, i) => turnView(turn, i, t)).join('')}
    <div class="dock">${box('sq-follow', followDraft, 'Ask a follow-up…', running)}</div>
  </section>`;
}

// ------------------------------------------------------------------ searching

async function runSearch(thread, turn) {
  controller?.abort();
  controller = new AbortController();
  const history = thread.turns.filter((x) => x !== turn && x.answer).slice(-3).map((x) => ({ q: x.q, a: x.answer.slice(0, 1500) }));
  Object.assign(turn, { running: true, stage: 'Starting…', answer: '', sources: [], related: [], queries: [], error: '' });
  paint();
  try {
    const res = await fetch('api/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: turn.q, depth: turn.depth, history }),
      signal: controller.signal,
    });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('event-stream')) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Search failed (${res.status}).`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const line = buffer.slice(0, cut).split('\n').find((l) => l.startsWith('data:'));
        buffer = buffer.slice(cut + 2);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5)); } catch { continue; }
        if (evt.type === 'status') turn.stage = (STAGES[evt.stage] || (() => ''))(evt);
        else if (evt.type === 'queries') turn.queries = evt.queries;
        else if (evt.type === 'sources') turn.sources = evt.sources;
        else if (evt.type === 'text') { turn.answer += evt.text; turn.stage = ''; }
        else if (evt.type === 'related') turn.related = evt.questions;
        else if (evt.type === 'error') turn.error = evt.message;
        else if (evt.type === 'done') { turn.model = evt.model; turn.ms = evt.ms; }
        paint();
      }
    }
    if (!turn.answer && !turn.error) turn.error = 'No answer came back. Please retry.';
  } catch (err) {
    turn.error = err.name === 'AbortError' ? 'Stopped.' : (err.message || 'Search failed. Please retry.');
  } finally {
    turn.running = false;
    turn.stage = '';
    save();
    paint();
  }
}

function ask(q, { follow = false, mode = depth } = {}) {
  q = String(q || '').trim().slice(0, 500);
  if (!q) return;
  if (busy()) { toast('Wait for the current search to finish, or stop it.'); return; }
  let thread = follow ? current() : null;
  if (!thread) {
    thread = { id: uid(), createdAt: Date.now(), turns: [] };
    threads.unshift(thread);
    threads = threads.slice(0, MAX_THREADS);
  }
  const turn = { q, depth: mode, at: Date.now() };
  thread.turns.push(turn);
  draft = '';
  followDraft = '';
  if (threadId() !== thread.id) location.hash = `#/search?t=${thread.id}`;
  runSearch(thread, turn);
}

function copyText(turn) {
  const refs = (turn.sources || []).map((s) => `[${s.n}] ${s.title} — ${s.url}`).join('\n');
  return `${turn.q}\n\n${turn.answer}${refs ? `\n\nSources\n${refs}` : ''}`;
}

export function bind(root, rerender) {
  rerenderRef = rerender;
  root.addEventListener('input', (e) => {
    if (e.target.name === 'sq') draft = e.target.value;
    if (e.target.name === 'sq-follow') followDraft = e.target.value;
    if (e.target.tagName === 'TEXTAREA') {
      e.target.style.height = 'auto';
      e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
    }
  });
  root.addEventListener('keydown', (e) => {
    if ((e.target.name === 'sq' || e.target.name === 'sq-follow') && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.target.form.requestSubmit();
    }
  });
  root.addEventListener('submit', (e) => {
    if (e.target.dataset.form !== 'search') return;
    e.preventDefault();
    const ta = e.target.querySelector('textarea');
    ask(ta.value, { follow: ta.name === 'sq-follow' });
  });
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const t = current();
    const turn = t?.turns[Number(b.dataset.i)];
    switch (b.dataset.action) {
      case 'depth': depth = b.dataset.depth; rerender(); break;
      case 'ask': ask(b.dataset.q, { follow: Boolean(t) }); break;
      case 'stop': controller?.abort(); break;
      case 'pro': if (turn) ask(turn.q, { follow: true, mode: 'pro' }); break;
      case 'copy':
        if (!turn) break;
        try { await navigator.clipboard.writeText(copyText(turn)); toast('Answer copied with its sources.'); } catch { toast('Copy failed.'); }
        break;
      case 'clear':
        threads = [];
        save();
        rerender();
        break;
      default:
    }
  });
}
