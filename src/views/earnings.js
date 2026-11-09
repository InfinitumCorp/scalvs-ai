import { getState, update, addLedger, reset } from '../store.js';
import { PLANS, DATASETS, REWARD_RULES } from '../data.js';
import { esc, fmt, ago, toast } from '../ui.js';
import { startUpgrade, openPortal } from '../billing.js';
import {
  BUYERS, CATEGORIES, NEVER_SOLD, EXCHANGE_PRODUCTS, SHARE, SCLV_PER_USD, MIN_COHORT,
  ensureExchange, hasConsent, setConsent, withdrawAll, available, quoteSale, applySale,
} from '../exchange.js';

// Prices from the revenue catalog (src/catalog.ts in infinitum-revenue), per month.
const PRICE = { free: '$0', pro: '$29 / month · 14-day trial', business: '$49 / seat / month', government: 'Contact sales' };
let billingEmail = '';
let billingBusy = false;

async function choosePlan(id) {
  const s = getState();
  if (billingBusy || id === s.plan) return;
  if (id === 'government') { toast('Government plans are sold by contract. Contact Infinitum sales.'); return; }
  // Downgrades and plan changes for an existing subscription go through the Stripe portal.
  if (id === 'free' || (s.billing?.apiKey && s.plan !== 'free')) { manageBilling(); return; }
  billingBusy = true;
  update(() => {});
  try {
    const { billing, url } = await startUpgrade({ billing: s.billing, planId: id, email: billingEmail, origin: location.origin });
    update((st) => { st.billing = billing; });
    location.assign(url);
  } catch (err) {
    toast(err.message);
    if (err.code === 'email_required') document.querySelector('[name="billing-email"]')?.focus();
  } finally {
    billingBusy = false;
    update(() => {});
  }
}

async function manageBilling() {
  const s = getState();
  if (!s.billing?.apiKey) { toast('You are on the Free plan.'); return; }
  try { location.assign(await openPortal({ billing: s.billing, origin: location.origin })); }
  catch (err) { toast(err.message); }
}

// Global Privacy Control: a legally recognized "do not sell" signal.
const gpc = () => typeof navigator !== 'undefined' && navigator.globalPrivacyControl === true;
let saleBuyer = 'ads';

function exchangePanel(s) {
  const ex = ensureExchange(s.wallet);
  const avail = available(s, ex);
  const blockedByGpc = gpc();
  const anyConsent = Object.keys(ex.consent).length > 0;
  const quote = quoteSale(s, ex, saleBuyer, { gpc: blockedByGpc });
  return `
  <section class="panel" id="exchange">
    <div class="panel-head"><h2>Data exchange</h2><span class="tag">you keep ${SHARE * 100}% · paid in $SCLV</span></div>
    <p class="small">You create data by using Infinitum products. If you allow it, Infinitum sells it in de-identified segments, pooled with at least ${fmt(MIN_COHORT)} other people, and pays you ${SHARE * 100}% of the sale in $SCLV. Everything is off until you turn it on, and you can turn it off at any time.</p>
    ${blockedByGpc ? '<p class="notice small">Your browser sends Global Privacy Control. We treat it as an opt-out, so none of your data is sold.</p>' : ''}
    <div class="table-wrap"><table class="table consent">
      <thead><tr><th>Your data</th><th class="num">Ready</th>${BUYERS.map((b) => `<th class="center" title="${esc(b.desc)}">${esc(b.name)}</th>`).join('')}</tr></thead>
      <tbody>${CATEGORIES.map((c) => `
        <tr><td><strong>${esc(c.name)}</strong><p class="muted tiny">${esc(c.desc)}</p></td>
          <td class="num">${fmt(avail[c.id])}</td>
          ${BUYERS.map((b) => `<td class="center"><input type="checkbox" data-action="consent" data-cat="${c.id}" data-buyer="${b.id}" aria-label="Allow ${esc(c.name)} to be sold to ${esc(b.name)}" ${hasConsent(ex, c.id, b.id) ? 'checked' : ''} ${blockedByGpc ? 'disabled' : ''}></td>`).join('')}
        </tr>`).join('')}
      </tbody></table></div>
    <div class="row gap wrap">
      <label class="inline">Sell to
        <select data-action="sale-buyer">${BUYERS.map((b) => `<option value="${b.id}" ${saleBuyer === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
      </label>
      <button class="btn sm primary" data-action="sale" ${quote.blocked ? 'disabled' : ''}>Simulate sale${quote.blocked ? '' : ` · +${fmt(quote.sclv, 2)} $SCLV`}</button>
      ${anyConsent ? '<button class="btn ghost sm" data-action="withdraw-all">Withdraw all consent</button>' : ''}
    </div>
    ${quote.blocked ? `<p class="muted small">${esc(quote.blocked)}</p>` : ''}
    <details class="small"><summary>Never sold, whatever you choose</summary><ul class="plain">${NEVER_SOLD.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>
    <details class="small"><summary>Which products contribute</summary><p class="muted">${EXCHANGE_PRODUCTS.map(esc).join(', ')}. Only SCALVS.ai is connected in this prototype. Defense, identity and network products never contribute.</p></details>
  </section>`;
}

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
    <div class="stat"><span class="stat-n">${fmt(w.sclv, Number.isInteger(w.sclv) ? 0 : 2)}</span><span class="muted small">$SCLV (simulated)</span></div>
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

  ${exchangePanel(s)}

  <section class="panel">
    <div class="panel-head"><h2>Ad revenue sharing</h2><span class="tag">${s.plan === 'free' ? 'Free plan' : 'Not available on paid plans'}</span></div>
    <p class="small muted">Opt into sponsored placements in the dashboard and receive your share in $SCLV. Ads never appear in documents, AI answers or workflows.</p>
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
      ${w.ledger.map((t) => `<tr><td class="muted">${ago(t.at)}</td><td>${esc(t.note)}</td><td class="num">+${fmt(t.amount, Number.isInteger(t.amount) ? 0 : 2)} ${esc(t.unit)}</td></tr>`).join('')}
    </tbody></table>` : '<p class="muted small">No simulated transactions. Task completion does not create rewards.</p>'}
  </section>

  <section class="panel" id="plans">
    <div class="panel-head"><h2>Plans</h2>${s.billing?.apiKey && s.plan !== 'free'
      ? '<button class="btn ghost sm" data-action="portal">Manage billing</button>' : ''}</div>
    <div class="plans">
      ${Object.entries(PLANS).map(([id, p]) => `
      <button class="plan ${s.plan === id ? 'sel' : ''}" data-action="plan" data-id="${id}" aria-pressed="${s.plan === id}" ${billingBusy ? 'disabled' : ''}>
        <strong>${p.label}</strong>
        <span class="small">${PRICE[id]}</span>
        <span class="small">${id === 'government' ? 'Contract' : `${p.agents}${id === 'business' ? '+' : ''} active agents`}</span>
        <span class="small muted">${p.workflow} workflows</span>
        <span class="small muted">Ads: ${p.ads}</span>
        <span class="small muted">${p.deploy}</span>
      </button>`).join('')}
    </div>
    ${s.billing?.apiKey ? `<p class="small muted">Billing email: ${esc(s.billing.email)}</p>` : `
    <label class="small">Billing email <input type="email" name="billing-email" autocomplete="email" placeholder="you@company.com" value="${esc(billingEmail)}"></label>`}
    <p class="small muted">Paid plans check out securely with Stripe. Cancel or change any time from Manage billing.</p>
  </section>

  <p class="center"><button class="btn ghost sm" data-action="reset">Reset prototype data</button></p>`;
}

export function bind(root) {
  // Keep typed text across re-renders.
  root.addEventListener('input', (e) => { if (e.target.name === 'billing-email') billingEmail = e.target.value; });
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.action === 'ads') {
      update((st) => { st.wallet.adsOptIn = t.checked; });
    } else if (t.dataset.action === 'consent') {
      if (gpc()) return;
      update((st) => { setConsent(ensureExchange(st.wallet), t.dataset.cat, t.dataset.buyer, t.checked); });
    } else if (t.dataset.action === 'sale-buyer') {
      saleBuyer = t.value;
      update(() => {});
    }
  });
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || ['ads', 'consent', 'sale-buyer'].includes(el.dataset.action)) return;
    const { action, id } = el.dataset;
    const ds = DATASETS.find((d) => d.id === id);
    if (action === 'sale') {
      let paid = 0;
      update((st) => {
        const ex = ensureExchange(st.wallet);
        const quote = quoteSale(st, ex, saleBuyer, { gpc: gpc() });
        paid = applySale(ex, quote);
        if (!paid) return;
        st.wallet.sclv = Math.round((st.wallet.sclv + paid) * 100) / 100;
        const what = quote.lines.map((l) => `${l.name} (${fmt(l.points)})`).join(', ');
        addLedger({ kind: 'exchange', amount: paid, unit: '$SCLV', note: `Sold to ${quote.buyer.name.toLowerCase()}: ${what} · your ${SHARE * 100}%` });
      });
      toast(paid ? `+${fmt(paid, 2)} $SCLV (simulated)` : 'Nothing to sell');
    } else if (action === 'withdraw-all') {
      update((st) => { withdrawAll(ensureExchange(st.wallet)); });
      toast('Consent withdrawn. Nothing more will be sold.');
    } else if (action === 'ads-day') {
      const sclv = REWARD_RULES.adSharePerDay * SCLV_PER_USD;
      update((st) => {
        st.wallet.sclv += sclv;
        addLedger({ kind: 'ads', amount: sclv, unit: '$SCLV', note: 'Ad revenue share (1 day)' });
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
      choosePlan(id);
    } else if (action === 'portal') {
      manageBilling();
    } else if (action === 'reset') {
      if (confirm('Reset all prototype data?')) { reset(); toast('Prototype reset'); }
    }
  });
}

