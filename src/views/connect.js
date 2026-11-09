import { PLUGINS, pluginsPanel, setPlugin } from '../grok.js';
// Connect: real connectors (remote MCP servers and built-in app adapters, signed in
// through api/connectors.js) plus Infinitum products and the Nexus Context Vault.
// Tokens stay on the server; this page only sees names, status and tool lists.
import { getState, update, uid } from '../store.js';
import { CATALOG, CONNECTOR_GROUPS } from '../connectors.js';
import { esc, toast } from '../ui.js';

const PRODUCTS = ['SCALVS.ai', '+SPCTR', 'VEIL</>', 'METATRON¹⁰⁰', 'FABRIC'];
const API = 'api/connectors';

let remote = null;        // { catalog, custom, connections } from the server
let loadError = null;
let rerender = () => {};
const ui = { q: '', open: null, busy: null, tokenFor: null, tokenHelp: '', test: { id: null, tool: '', args: '{}', out: '', busy: false } };

async function api(path, method = 'GET', body) {
  const res = await fetch(`${API}${path}`, {
    method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data });
  return data;
}

async function load() {
  try { remote = await api(''); loadError = null; }
  catch (e) { loadError = e.message; }
  rerender();
}

// ---------- rendering ----------
const conns = () => remote?.connections || {};
const catalog = () => remote?.catalog || CATALOG;

function toolSummary(c) {
  if (c.error) return `<span class="err-text">${esc(c.error)}</span>`;
  const on = c.tools.filter((t) => t.enabled).length;
  return `${c.tools.length} tool${c.tools.length === 1 ? '' : 's'} · ${on} on for agents`;
}

function exampleArgs(schema) {
  const out = {};
  for (const k of schema?.required || []) {
    const p = schema.properties?.[k] || {};
    out[k] = p.type === 'number' || p.type === 'integer' ? 1 : p.type === 'boolean' ? false : p.type === 'array' ? [] : '';
  }
  return JSON.stringify(out, null, 2);
}

function manage(entry, c) {
  const t = ui.test.id === entry.id ? ui.test : { tool: '', args: '{}', out: '', busy: false };
  return `
  <div class="conn-manage">
    <p class="tiny muted">Read-only tools are on for agents by default. Tools that change things (send, post, create) start off; switch them on only if agents should do that without asking.</p>
    <ul class="list tools-list">
      ${c.tools.map((tool) => `
      <li class="list-row">
        <div class="list-main"><div>
          <strong class="mono small">${esc(tool.name)}</strong> <span class="tag">${tool.readOnly ? 'reads' : 'writes'}</span>
          <p class="muted tiny">${esc(tool.description.slice(0, 220))}</p>
        </div></div>
        <label class="switch" title="Agents can use this tool">
          <input type="checkbox" data-action="tool-perm" data-id="${esc(entry.id)}" data-tool="${esc(tool.name)}" ${tool.enabled ? 'checked' : ''} aria-label="Agents can use ${esc(tool.name)}"><span></span>
        </label>
      </li>`).join('') || '<li class="muted small">This connector has no tools.</li>'}
    </ul>
    ${c.tools.length ? `
    <form class="form test-form" data-id="${esc(entry.id)}">
      <div class="grid2">
        <label>Try a tool yourself
          <select name="test-tool" data-action="test-tool" data-id="${esc(entry.id)}">
            <option value="">Choose…</option>
            ${c.tools.map((tool) => `<option value="${esc(tool.name)}" ${t.tool === tool.name ? 'selected' : ''}>${esc(tool.name)}</option>`).join('')}
          </select>
        </label>
        <label>Arguments (JSON)<textarea name="test-args" rows="3" class="mono small">${esc(t.args)}</textarea></label>
      </div>
      <div class="row gap"><button class="btn sm" type="submit" ${t.busy || !t.tool ? 'disabled' : ''}>${t.busy ? 'Running…' : 'Run'}</button></div>
      ${t.out ? `<pre class="tool-out">${esc(t.out)}</pre>` : ''}
    </form>` : ''}
    <div class="row gap">
      <button class="btn ghost sm" data-action="refresh" data-id="${esc(entry.id)}">Refresh tools</button>
    </div>
  </div>`;
}

function row(entry) {
  const c = conns()[entry.id];
  const busy = ui.busy === entry.id;
  const setup = entry.ready === false && !c;
  let action;
  if (c) {
    action = `<button class="btn ghost sm" data-action="manage" data-id="${esc(entry.id)}" aria-expanded="${ui.open === entry.id}">${ui.open === entry.id ? 'Close' : 'Manage'}</button>
      <button class="btn sm" data-action="disconnect" data-id="${esc(entry.id)}" ${busy ? 'disabled' : ''}>Disconnect</button>`;
  } else {
    action = `<button class="btn sm primary" data-action="connect" data-id="${esc(entry.id)}" ${busy ? 'disabled' : ''}>${busy ? 'Connecting…' : 'Connect'}</button>`;
  }
  if (entry.group === 'Custom') action += `<button class="btn ghost sm" data-action="remove-custom" data-id="${esc(entry.id)}" aria-label="Remove ${esc(entry.name)}">Remove</button>`;
  return `
  <li class="list-row conn-row">
    <div class="list-main">
      <span class="dot ${c && !c.error ? 'on' : ''}" aria-hidden="true"></span>
      <div>
        <strong>${esc(entry.name)}</strong>${setup ? ' <span class="tag">needs setup</span>' : ''}
        <p class="muted small">${c ? toolSummary(c) : esc(entry.desc)}</p>
      </div>
    </div>
    <div class="row gap conn-actions">${action}</div>
  </li>
  ${ui.tokenFor === entry.id ? `
  <li class="token-row">
    <form class="row gap inline-form token-form" data-id="${esc(entry.id)}">
      <input name="token" type="password" required autocomplete="off" placeholder="Access token or API key" aria-label="Access token for ${esc(entry.name)}">
      <button class="btn primary" type="submit">Connect</button>
      <button class="btn ghost" type="button" data-action="cancel-token">Cancel</button>
    </form>
    <p class="tiny muted">${esc(ui.tokenHelp)} It is encrypted on the server and never stored in this browser.</p>
  </li>` : ''}
  ${c && ui.open === entry.id ? `<li>${manage(entry, c)}</li>` : ''}`;
}

export function render() {
  const s = getState();
  const all = catalog();
  const custom = (remote?.custom || []).map((x) => ({ ...x, kind: 'mcp', group: 'Custom', desc: x.url }));
  const q = ui.q.trim().toLowerCase();
  const match = (e) => !q || `${e.name} ${e.desc}`.toLowerCase().includes(q);
  const connectedEntries = [...all, ...custom].filter((e) => e.kind !== 'builtin' && conns()[e.id]);
  const builtin = all.filter((e) => e.kind === 'builtin');

  return `
  <header class="page-head">
    <p class="eyebrow">02 / Connect</p>
    <h1>Connectors</h1>
    <p class="lede">Connect your apps so agents can look things up and act with your permission. Built on the open Model Context Protocol: pick from the directory or add any MCP server.</p>
  </header>

  ${loadError ? `<p class="notice err-text">Connectors are unavailable: ${esc(loadError)} <button class="btn ghost sm" data-action="reload">Retry</button></p>` : ''}
  ${!remote && !loadError ? '<p class="muted small">Loading connectors…</p>' : ''}

  ${connectedEntries.length ? `
  <section class="panel">
    <div class="panel-head"><h2>Connected</h2><span class="tag">${connectedEntries.length}</span></div>
    <ul class="list">${connectedEntries.map(row).join('')}</ul>
  </section>` : ''}

  ${CONNECTOR_GROUPS.filter((g) => g !== 'Infinitum Nexus').map((g) => {
    const items = all.filter((e) => e.group === g && !conns()[e.id] && match(e));
    return `
  <section class="panel">
    <div class="panel-head">
      <h2>${g === 'Directory' ? 'Browse connectors' : esc(g)}</h2>
      ${g === 'Directory' ? `<input name="conn-search" class="conn-search" type="search" placeholder="Search connectors" aria-label="Search connectors" value="${esc(ui.q)}">` : ''}
    </div>
    <ul class="list">${items.map(row).join('') || `<li class="muted small">${q ? 'No connectors match.' : 'All connected.'}</li>`}</ul>
  </section>`;
  }).join('')}

  <section class="panel">
    <div class="panel-head"><h2>Custom connectors</h2><span class="tag">any remote MCP server</span></div>
    <ul class="list">${custom.filter((e) => !conns()[e.id]).map(row).join('')}</ul>
    <form id="custom-form" class="form custom-form">
      <div class="grid2">
        <label>Name<input name="custom-name" required maxlength="40" placeholder="My server"></label>
        <label>Remote MCP server URL<input name="custom-url" type="url" required placeholder="https://example.com/mcp"></label>
      </div>
      <p class="tiny muted">Streamable HTTP endpoint. If the server supports OAuth you sign in with it; otherwise you are asked for a token. Only connect servers you trust: their tools see what agents send them.</p>
      <div class="row gap"><button class="btn primary" type="submit">Add connector</button></div>
    </form>
  </section>

  ${pluginsPanel()}

  <section class="panel">
    <div class="panel-head"><h2>Infinitum Nexus</h2><span class="tag">built in</span></div>
    <ul class="list">
      ${builtin.map((c) => {
        const on = Boolean(s.connections[c.id]);
        return `
        <li class="list-row">
          <div class="list-main">
            <span class="dot ${on ? 'on' : ''}" aria-hidden="true"></span>
            <div><strong>${esc(c.name)}</strong><p class="muted small">${esc(c.desc)}</p></div>
          </div>
          <div class="row-actions">
            ${c.url ? `<a class="btn sm" href="${esc(c.url)}" target="_blank" rel="noopener" aria-label="Open ${esc(c.name)} (opens in a new tab)">Open ↗</a>` : ''}
            <button class="btn sm ${on ? '' : 'primary'}" data-action="toggle-builtin" data-id="${c.id}" aria-pressed="${on}">${on ? 'Disconnect' : 'Connect'}</button>
          </div>
        </li>`;
      }).join('')}
    </ul>
  </section>

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

// ---------- actions ----------
const nameOf = (id) => [...catalog(), ...(remote?.custom || [])].find((e) => e.id === id)?.name || 'Connector';

async function connect(id, token) {
  ui.busy = id; rerender();
  try {
    const r = await api(`/${encodeURIComponent(id)}/connect`, 'POST', token ? { token } : {});
    if (r.redirect) { location.href = r.redirect; return; }
    if (r.needsToken) { ui.tokenFor = id; ui.tokenHelp = r.help; return; }
    if (r.connection) {
      remote.connections[id] = r.connection;
      ui.tokenFor = null; ui.open = id;
      toast(`${nameOf(id)} connected`);
    }
  } catch (e) {
    toast(e.message);
  } finally {
    if (ui.busy === id) ui.busy = null;
    rerender();
  }
}

function setConnection(id, connection) { remote.connections[id] = connection; rerender(); }

export function bind(root, rerenderView) {
  root.addEventListener('change', (e) => {
    const id = e.target.dataset?.plugin;
    if (!id) return;
    setPlugin(id, e.target.checked);
    toast(`${e.target.checked ? 'Enabled' : 'Disabled'} ${PLUGINS.find((p) => p.id === id)?.name}`);
    rerenderView();
  });
  rerender = rerenderView;
  // Back from an OAuth sign-in: #/connect?connected=id or ?connect_error=…
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  if (params.get('connected')) ui.open = params.get('connected');
  load().then(() => {
    if (params.get('connected')) toast(`${nameOf(params.get('connected'))} connected`);
  });
  if (params.get('connect_error')) toast(params.get('connect_error'));
  if (params.toString()) history.replaceState(null, '', '#/connect');

  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
    const { action, id, product } = el.dataset;
    try {
      if (action === 'connect') await connect(id);
      else if (action === 'cancel-token') { ui.tokenFor = null; rerender(); }
      else if (action === 'reload') load();
      else if (action === 'manage') { ui.open = ui.open === id ? null : id; rerender(); }
      else if (action === 'disconnect') {
        ui.busy = id; rerender();
        await api(`/${encodeURIComponent(id)}/disconnect`, 'POST', {});
        delete remote.connections[id];
        if (ui.open === id) ui.open = null;
        ui.busy = null;
        toast(`${nameOf(id)} disconnected`);
        rerender();
      } else if (action === 'refresh') {
        setConnection(id, (await api(`/${encodeURIComponent(id)}/refresh`, 'POST', {})).connection);
        toast('Tools refreshed');
      } else if (action === 'remove-custom') {
        if (!confirm(`Remove ${nameOf(id)}? Its sign-in is deleted too.`)) return;
        await api(`/custom/${encodeURIComponent(id)}`, 'DELETE');
        remote.custom = remote.custom.filter((c) => c.id !== id);
        delete remote.connections[id];
        rerender();
      } else if (action === 'toggle-builtin') {
        const c = CATALOG.find((x) => x.id === id);
        update((st) => { st.connections[id] = !st.connections[id]; });
        toast(`${c.name} ${getState().connections[id] ? 'connected' : 'disconnected'}`);
      } else if (action === 'vault-perm') {
        update((st) => {
          const m = st.vault.find((x) => x.id === id);
          m.products = m.products.includes(product) ? m.products.filter((p) => p !== product) : [...m.products, product];
        });
      } else if (action === 'vault-del') {
        update((st) => { st.vault = st.vault.filter((x) => x.id !== id); });
      }
    } catch (err) {
      ui.busy = null;
      toast(err.message);
      rerender();
    }
  });

  root.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.dataset.action === 'tool-perm') {
      try {
        const r = await api(`/${encodeURIComponent(el.dataset.id)}/tools/${encodeURIComponent(el.dataset.tool)}`, 'POST', { enabled: el.checked });
        setConnection(el.dataset.id, r.connection);
      } catch (err) { toast(err.message); rerender(); }
    } else if (el.dataset.action === 'test-tool') {
      const tool = conns()[el.dataset.id]?.tools.find((t) => t.name === el.value);
      Object.assign(ui.test, { id: el.dataset.id, tool: el.value, args: tool ? exampleArgs(tool.inputSchema) : '{}', out: '' });
      rerender();
    }
  });

  root.addEventListener('input', (e) => {
    if (e.target.name === 'conn-search') { ui.q = e.target.value; rerender(); }
    if (e.target.name === 'test-args') ui.test.args = e.target.value;
  });

  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = new FormData(form);
    if (form.id === 'vault-form') {
      const text = String(data.get('text') || '').trim();
      if (text) update((st) => { st.vault.push({ id: uid('mem'), text, products: ['SCALVS.ai'] }); });
    } else if (form.id === 'custom-form') {
      try {
        const { custom } = await api('/custom', 'POST', { name: data.get('custom-name'), url: data.get('custom-url') });
        remote.custom.push(custom);
        form.reset();
        await connect(custom.id);
      } catch (err) { toast(err.message); }
    } else if (form.classList.contains('token-form')) {
      await connect(form.dataset.id, String(data.get('token') || '').trim());
    } else if (form.classList.contains('test-form')) {
      let args;
      try { args = JSON.parse(ui.test.args || '{}'); } catch { toast('Arguments must be valid JSON'); return; }
      Object.assign(ui.test, { busy: true, out: '' });
      rerender();
      try {
        const r = await api(`/${encodeURIComponent(form.dataset.id)}/call`, 'POST', { tool: ui.test.tool, args });
        ui.test.out = (r.isError ? 'Error: ' : '') + (r.text || '(no output)');
      } catch (err) { ui.test.out = `Error: ${err.message}`; }
      ui.test.busy = false;
      rerender();
    }
  });
}
