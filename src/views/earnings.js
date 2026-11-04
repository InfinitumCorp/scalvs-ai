import { getState, update, addLedger, reset } from '../store.js';
import { PLANS, DATASETS, REWARD_RULES } from '../data.js';
import { esc, fmt, ago, toast } from '../ui.js';

export function render() {
  const s = getState();
  const w = s.wallet;
  const capLeft = Math.max(0, REWARD_RULES.sclvWeeklyCap - (w.sclvThisWeek || 0));
  return `
  <header class="page-head">
    <p class="eyebrow">04 / Earn</p>
    <h1>Earnings & Data Wallet</h1>
    <p class="lede">Ads, data licensing and $SCLV rewards.</p>
    <p class="notice small">Simulated balances. No real tokens, blockchain transactions or payments happen in this prototype.</p>
  </header>

  <div class="stats">
    <div class="stat"><span class="stat-n">${fmt(w.sclv)}</span><span class="muted small">$SCLV (simulated)</span></div>
    <div class="stat"><span class="stat-n">${fmt(w.activity)}</span><span class="muted small">Activity credits</span></div>
    <div class="stat"><span class="stat-n">$${fmt(w.usd, 2)}</span><span class="muted small">Revenue share</span></div>
    <div class="stat"><span class="stat-n">${fmt(capLeft)}</span><span class="muted small">$SCLV left in weekly cap</span></div>
  </div>

  <section class="panel">
    <div class="panel-head"><h2>How rewards work</h2></div>
    <ul class="plain small">
      <li>Every agent step uses ${REWARD_RULES.creditsPerRun} AI credits from your plan.</li>
      <li>Completing or approving a draft does not verify a contribution or earn tokens.</li>
      <li>Contribution verification and reward settlement are not connected yet. The balances below are examples only.</li>
    </ul>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Ad revenue sharing</h2><span class="tag">${s.plan === 'free' ? 'Free plan' : 'Not available on paid plans'}</span></div>
    <p class="small muted">Opt into sponsored placements in the dashboard and receive a share. Ads never appear in documents, AI answers or workflows.</p>
    <div class="row gap">
      <label class="switch"><input type="checkbox" data-action="ads" ${w.adsOptIn ? 'checked' : ''} ${s.plan === 'free' ? '' : 'disabled'}><span></span> Show sponsored placements</label>
      ${w.adsOptIn && s.plan === 'free' ? '<button class="btn sm" data-action="ads-day">Simulate a day</button>' : ''}
    </div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Data licensing</h2><span class="tag">keep ${REWARD_RULES.dataShare * 100}% of every verified sale</span></div>
    <ul class="list">
      ${DATASETS.map((d) => {
        const st = w.datasets[d.id] || 'private';
        return `
        <li class="list-row">
          <div class="list-main"><div><strong>${esc(d.name)}</strong><p class="muted small">${esc(d.size)} · list price $${d.price}</p></div></div>
          <div class="row gap">
            ${st === 'private' ? `<button class="btn sm primary" data-action="ds-approve" data-id="${d.id}">Approve for licensing</button>` : `
              <span class="status-pill completed">Listed</span>
              <button class="btn sm" data-action="ds-sale" data-id="${d.id}">Simulate sale</button>
              <button class="btn ghost sm" data-action="ds-withdraw" data-id="${d.id}">Withdraw</button>`}
          </div>
        </li>`;
      }).join('')}
    </ul>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Ledger</h2><span class="tag">would settle on Firmament Network</span></div>
    ${w.ledger.length ? `<table class="table"><thead><tr><th>When</th><th>What</th><th class="num">Amount</th></tr></thead><tbody>
      ${w.ledger.map((t) => `<tr><td class="muted">${ago(t.at)}</td><td>${esc(t.note)}</td><td class="num">+${fmt(t.amount, t.unit === 'USD' ? 2 : 0)} ${esc(t.unit)}</td></tr>`).join('')}
    </tbody></table>` : '<p class="muted small">No simulated transactions. Task completion does not create rewards.</p>'}
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Plans</h2></div>
    <div class="plans">
      ${Object.entries(PLANS).map(([id, p]) => `
      <button class="plan ${s.plan === id ? 'sel' : ''}" data-action="plan" data-id="${id}" aria-pressed="${s.plan === id}">
        <strong>${p.label}</strong>
        <span class="small">${id === 'government' ? 'Contract' : `${p.agents}${id === 'business' ? '+' : ''} active agents`}</span>
        <span class="small muted">${p.workflow} workflows</span>
        <span class="small muted">Ads: ${p.ads}</span>
        <span class="small muted">${p.deploy}</span>
      </button>`).join('')}
    </div>
    <p class="small muted">Switching plans here only changes prototype limits.</p>
  </section>

  <p class="center"><button class="btn ghost sm" data-action="reset">Reset prototype data</button></p>`;
}

export function bind(root) {
  root.addEventListener('change', (e) => {
    if (e.target.dataset.action === 'ads') {
      update((st) => { st.wallet.adsOptIn = e.target.checked; });
    }
  });
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.dataset.action === 'ads') return;
    const { action, id } = el.dataset;
    const ds = DATASETS.find((d) => d.id === id);
    if (action === 'ads-day') {
      update((st) => {
        st.wallet.usd += REWARD_RULES.adSharePerDay;
        addLedger({ kind: 'ads', amount: REWARD_RULES.adSharePerDay, unit: 'USD', note: 'Ad revenue share (1 day)' });
      });
    } else if (action === 'ds-approve') {
      update((st) => { st.wallet.datasets[id] = 'listed'; });
      toast(`${ds.name} listed on Cumulus://Cloud`);
    } else if (action === 'ds-withdraw') {
      update((st) => { st.wallet.datasets[id] = 'private'; });
    } else if (action === 'ds-sale') {
      const share = ds.price * REWARD_RULES.dataShare;
      update((st) => {
        st.wallet.usd += share;
        addLedger({ kind: 'data', amount: share, unit: 'USD', note: `Verified sale: ${ds.name} (85%)` });
      });
      toast(`+$${share.toFixed(2)} from ${ds.name}`);
    } else if (action === 'plan') {
      update((st) => { st.plan = id; if (id !== 'free') st.wallet.adsOptIn = false; });
      toast(`Switched to ${PLANS[id].label}`);
    } else if (action === 'reset') {
      if (confirm('Reset all prototype data?')) { reset(); toast('Prototype reset'); }
    }
  });
}

