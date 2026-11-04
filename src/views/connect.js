import { getState, update, uid } from '../store.js';
import { CONNECTORS } from '../data.js';
import { esc, toast } from '../ui.js';

const PRODUCTS = ['SCALVS.ai', '+SPCTR', 'VEIL</>', 'METATRON¹⁰⁰', 'FABRIC'];

export function render() {
  const s = getState();
  const groups = [...new Set(CONNECTORS.map((c) => c.group))];
  return `
  <header class="page-head">
    <p class="eyebrow">02 / Connect</p>
    <h1>Plug in your world</h1>
    <p class="lede">Accounts, apps and every Infinitum product. Connections are simulated in this prototype.</p>
  </header>

  ${groups.map((g) => `
  <section class="panel">
    <div class="panel-head"><h2>${esc(g)}</h2></div>
    <ul class="list">
      ${CONNECTORS.filter((c) => c.group === g).map((c) => {
        const on = Boolean(s.connections[c.id]);
        return `
        <li class="list-row">
          <div class="list-main">
            <span class="dot ${on ? 'on' : ''}" aria-hidden="true"></span>
            <div><strong>${esc(c.name)}</strong><p class="muted small">${esc(c.desc)}</p></div>
          </div>
          <button class="btn sm ${on ? '' : 'primary'}" data-action="toggle-conn" data-id="${c.id}" aria-pressed="${on}">${on ? 'Disconnect' : 'Connect'}</button>
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

export function bind(root) {
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id, product } = el.dataset;
    if (action === 'toggle-conn') {
      const c = CONNECTORS.find((x) => x.id === id);
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
  });
  root.addEventListener('submit', (e) => {
    if (e.target.id !== 'vault-form') return;
    e.preventDefault();
    const text = new FormData(e.target).get('text').trim();
    if (!text) return;
    update((st) => { st.vault.push({ id: uid('mem'), text, products: ['SCALVS.ai'] }); });
  });
}
