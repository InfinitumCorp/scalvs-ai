import { getState, update, uid } from '../store.js';
import { CONNECTORS } from '../data.js';
import { esc, toast } from '../ui.js';
import { GOOGLE_IDS, connectorMode, googlePost, googleStatus } from '../google.js';

const PRODUCTS = ['SCALVS.ai', '+SPCTR', 'VEIL</>', 'METATRON¹⁰⁰', 'FABRIC'];

let remote = null;
let googleNote = '';
let googleItems = [];

const NOTICES = {
  connected: 'Google account connected',
  denied: 'Google consent was not granted',
  error: 'Google connection failed',
};

function lede() {
  if (!remote) return 'Accounts, apps and every Infinitum product.';
  if (remote.configured) return 'Email, Docs & files, and Calendar can use your Google account after you consent. Other connections stay simulated in this prototype.';
  return 'Accounts, apps and every Infinitum product. Connections are simulated in this prototype.';
}

function googlePanel() {
  if (!remote?.configured) return '';
  const on = remote.connectors || {};
  const blocks = [];
  if (on.gmail) {
    blocks.push(`
      <div>
        <h3>Email</h3>
        <p class="small muted">Read recent threads, or save a draft. Mail is not sent.</p>
        <div class="row gap"><button class="btn sm" type="button" data-action="gmail-list">Show recent threads</button></div>
        <form id="gmail-draft" class="form subform">
          <label>To<input name="to" type="email" required maxlength="254" autocomplete="off"></label>
          <label>Subject<input name="subject" required maxlength="200"></label>
          <label>Message<textarea name="body" required maxlength="20000" rows="4"></textarea></label>
          <button class="btn primary sm" type="submit">Save draft</button>
        </form>
      </div>`);
  }
  if (on.drive) {
    blocks.push(`
      <div>
        <h3>Docs & files</h3>
        <form id="drive-list" class="row gap inline-form">
          <input name="query" maxlength="80" placeholder="Name contains… (optional)" aria-label="File name filter">
          <button class="btn sm" type="submit">List files</button>
        </form>
        <form id="drive-read" class="row gap inline-form">
          <input name="id" required maxlength="128" placeholder="File id" aria-label="File id">
          <button class="btn sm" type="submit">Read</button>
        </form>
      </div>`);
  }
  if (on.calendar) {
    blocks.push(`
      <div>
        <h3>Calendar</h3>
        <div class="row gap"><button class="btn sm" type="button" data-action="calendar-list">Show upcoming events</button></div>
        <form id="calendar-create" class="form subform">
          <label>Title<input name="summary" required maxlength="200"></label>
          <div class="grid2">
            <label>Start<input name="start" required placeholder="2026-11-09T15:00:00Z"></label>
            <label>End<input name="end" required placeholder="2026-11-09T15:30:00Z"></label>
          </div>
          <button class="btn primary sm" type="submit">Create event</button>
        </form>
      </div>`);
  }
  const results = googleItems.length
    ? `<ul class="list">${googleItems.map((item) => `<li class="list-row"><div class="list-main"><div><strong>${esc(item.title)}</strong><p class="muted small">${esc(item.detail)}</p></div></div></li>`).join('')}</ul>`
    : '';
  const note = googleNote ? `<p class="small ${googleNote.startsWith('Could not') ? 'error' : 'muted'}">${esc(googleNote)}</p>` : '';
  return `
  <section class="panel">
    <div class="panel-head"><h2>Google account</h2><span class="tag">your consent</span></div>
    <p class="small muted">Actions run only when you use the controls below. Disconnect removes that connector. The last one also revokes the stored authorization.</p>
    ${blocks.join('') || '<p class="small muted">Connect Email, Docs &amp; files, or Calendar to use your Google account.</p>'}
    ${note}
    ${results}
  </section>`;
}

export function render() {
  const s = getState();
  const groups = [...new Set(CONNECTORS.map((c) => c.group))];
  return `
  <header class="page-head">
    <p class="eyebrow">02 / Connect</p>
    <h1>Plug in your world</h1>
    <p class="lede">${lede()}</p>
  </header>
  ${googlePanel()}
  ${groups.map((g) => `
  <section class="panel">
    <div class="panel-head"><h2>${esc(g)}</h2></div>
    <ul class="list">
      ${CONNECTORS.filter((c) => c.group === g).map((c) => {
        const mode = connectorMode(remote, c.id, s.connections[c.id]);
        const on = mode.on;
        const control = mode.mode === 'google'
          ? (on
            ? `<button class="btn sm" type="button" data-action="google-disconnect" data-id="${c.id}" aria-pressed="true">Disconnect</button>`
            : `<a class="btn sm primary" href="api/google/connect?connector=${c.id}">Connect</a>`)
          : `<button class="btn sm ${on ? '' : 'primary'}" data-action="toggle-conn" data-id="${c.id}" aria-pressed="${on}">${on ? 'Disconnect' : 'Connect'}</button>`;
        return `
        <li class="list-row">
          <div class="list-main">
            <span class="dot ${on ? 'on' : ''}" aria-hidden="true"></span>
            <div><strong>${esc(c.name)}</strong><p class="muted small">${esc(c.desc)}</p></div>
          </div>
          ${control}
        </li>`;
      }).join('')}
    </ul>
  </section>`).join('')}

  <section class="panel">
    <div class="panel-head">
      <h2>Nexus Context Vault</h2>
      <span class="tag">shared only with your permission</span>
    </div>
    <p class="small muted">What you teach agents here carries into the products you allow. Agents with the Context Vault turned on read entries shared with SCALVS.ai.</p>
    <ul class="list">
      ${s.vault.map((m) => `
      <li class="list-row vault-row">
        <div class="list-main"><div>
          <p>${esc(m.text)}</p>
          <div class="chips">${PRODUCTS.map((p) => `<button class="chip ${m.products.includes(p) ? 'sel' : ''}" data-action="vault-perm" data-id="${m.id}" data-product="${esc(p)}" aria-pressed="${m.products.includes(p)}">${esc(p)}</button>`).join('')}</div>
        </div></div>
        <button class="btn ghost sm" data-action="vault-del" data-id="${m.id}">Remove</button>
      </li>`).join('') || '<li class="muted small">Nothing in the vault yet.</li>'}
    </ul>
    <form id="vault-form" class="row gap inline-form">
      <input name="text" required maxlength="400" placeholder="Add something agents should remember…" aria-label="New memory">
      <button class="btn primary" type="submit">Add</button>
    </form>
  </section>`;
}

function showItems(note, items) {
  googleNote = note;
  googleItems = items;
}

export function bind(root, rerender) {
  const flag = new URLSearchParams(location.hash.split('?')[1] || '').get('google');
  if (flag && NOTICES[flag]) {
    queueMicrotask(() => {
      toast(NOTICES[flag]);
      if (location.hash.startsWith('#/connect?')) location.hash = '#/connect';
    });
  }
  if (!remote) {
    googleStatus().then((status) => {
      if (!root.isConnected) return;
      remote = status;
      rerender();
    });
  }

  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    const { action, id, product } = el.dataset;
    if (action === 'toggle-conn') {
      if (remote?.configured && GOOGLE_IDS.includes(id)) return;
      const c = CONNECTORS.find((x) => x.id === id);
      update((st) => { st.connections[id] = !st.connections[id]; });
      toast(`${c.name} ${getState().connections[id] ? 'connected' : 'disconnected'}`);
    } else if (action === 'google-disconnect') {
      try {
        const data = await googlePost('api/google/disconnect', { connector: id });
        remote = { configured: true, connectors: data.connectors || {} };
        showItems('', []);
        const c = CONNECTORS.find((x) => x.id === id);
        toast(`${c?.name || 'Google'} disconnected`);
        rerender();
      } catch (err) {
        toast(err.message);
      }
    } else if (action === 'vault-perm') {
      update((st) => {
        const m = st.vault.find((x) => x.id === id);
        m.products = m.products.includes(product) ? m.products.filter((p) => p !== product) : [...m.products, product];
      });
    } else if (action === 'vault-del') {
      update((st) => { st.vault = st.vault.filter((x) => x.id !== id); });
    } else if (action === 'gmail-list') {
      try {
        const data = await googlePost('api/google/gmail/list', {});
        showItems(data.threads?.length ? '' : 'No recent threads.', (data.threads || []).map((thread) => ({
          title: thread.subject, detail: [thread.from, thread.date, thread.snippet].filter(Boolean).join(' · '),
        })));
        rerender();
      } catch (err) { showItems(`Could not read Gmail. ${err.message}`, []); rerender(); }
    } else if (action === 'calendar-list') {
      try {
        const data = await googlePost('api/google/calendar/list', {});
        showItems(data.events?.length ? '' : 'No upcoming events.', (data.events || []).map((event) => ({
          title: event.summary || '(no title)', detail: [event.start, event.end, event.location].filter(Boolean).join(' · '),
        })));
        rerender();
      } catch (err) { showItems(`Could not read Calendar. ${err.message}`, []); rerender(); }
    }
  });
  root.addEventListener('submit', async (e) => {
    const form = e.target;
    if (form.id === 'vault-form') {
      e.preventDefault();
      const text = new FormData(form).get('text').trim();
      if (!text) return;
      update((st) => { st.vault.push({ id: uid('mem'), text, products: ['SCALVS.ai'] }); });
      return;
    }
    if (form.id === 'gmail-draft') {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      try {
        const saved = await googlePost('api/google/gmail/draft', data);
        if (saved.sent) throw new Error('The draft was not supposed to be sent.');
        showItems('Draft saved in Gmail. It was not sent.', []);
        form.reset();
        rerender();
      } catch (err) { showItems(`Could not save the draft. ${err.message}`, []); rerender(); }
    } else if (form.id === 'drive-list') {
      e.preventDefault();
      const query = new FormData(form).get('query');
      try {
        const data = await googlePost('api/google/drive/list', { query });
        showItems(data.files?.length ? '' : 'No matching files.', (data.files || []).map((file) => ({
          title: file.name, detail: [file.mimeType, file.id].filter(Boolean).join(' · '),
        })));
        rerender();
      } catch (err) { showItems(`Could not list Drive. ${err.message}`, []); rerender(); }
    } else if (form.id === 'drive-read') {
      e.preventDefault();
      const id = new FormData(form).get('id');
      try {
        const data = await googlePost('api/google/drive/read', { id });
        const file = data.file || {};
        showItems('', [{ title: file.name || 'File', detail: file.text || 'No text content returned for this file.' }]);
        rerender();
      } catch (err) { showItems(`Could not read that file. ${err.message}`, []); rerender(); }
    } else if (form.id === 'calendar-create') {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      try {
        const created = await googlePost('api/google/calendar/create', data);
        showItems('Event created.', [{ title: created.summary, detail: `${created.start} → ${created.end}` }]);
        form.reset();
        rerender();
      } catch (err) { showItems(`Could not create the event. ${err.message}`, []); rerender(); }
    }
  });
}
