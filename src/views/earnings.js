import { getState, update, addLedger, reset } from '../store.js';
import { PLANS, DATASETS, REWARD_RULES } from '../data.js';
import { esc, fmt, ago, toast } from '../ui.js';
import {
  cidToken, loadCatalog, startCheckout, openPortal, switchToBusiness, businessOnly, formatPrice, FROM_REVENUE,
} from '../billing.js';
import {
  BUYERS, CATEGORIES, NEVER_SOLD, EXCHANGE_PRODUCTS, SHARE, SCLV_PER_USD, MIN_COHORT,
  ensureExchange, hasConsent, setConsent, withdrawAll, available, quoteSale, applySale,
} from '../exchange.js';

// Plans and billing through the Infinitum revenue API (src/billing.js), signed in with Cumulus ID.
const bill = {
  plans: null, // SCALVS.ai plans from /v1/catalog; null while loading
  catalogError: '',
  busy: '', // plan id, 'portal' or 'switch' while a request is open
  error: '',
  teamPlan: null, // business-only plan waiting on the "switch to business" step
  businessName: '',
  seats: 1,
};

const signedIn = () => !!cidToken();
const rerender = () => update(() => {});

async function loadPlans() {
  bill.catalogError = '';
  try { bill.plans = await loadCatalog(); } catch (err) { bill.plans = null; bill.catalogError = `Plans could not be loaded. ${err.message}`; }
  rerender();
}

/** The catalog plan this user is on: their entitlement, or Free when signed in without one. */
function currentPlanId(s) {
  if (!signedIn()) return null;
  return s.billing?.entitlement?.plan ?? 'scalvs_free';
}

async function act(key, fn) {
  if (bill.busy) return;
  bill.busy = key;
  bill.error = '';
  rerender();
  try {
    location.assign(await fn());
  } catch (err) {
    bill.error = err.message;
    bill.busy = '';
    rerender();
    if (err.code === 'name_required') document.querySelector('[name="business-name"]')?.focus();
  }
}

function choosePlan(id) {
  const s = getState();
  const p = bill.plans?.find((x) => x.id === id);
  if (!p || !signedIn() || id === currentPlanId(s)) return;
  if (p.channel === 'sales_assisted') { toast(`${p.name} is set up by Infinitum sales. Contact sales to get started.`); return; }
  // Downgrades and changes to an existing paid subscription go through the Stripe portal.
  if (!p.priceCents || currentPlanId(s) !== 'scalvs_free') { manageBilling(); return; }
  if (businessOnly(p)) {
    bill.teamPlan = id;
    bill.error = '';
    rerender();
    document.querySelector('[name="business-name"], [name="seats"]')?.focus();
    return;
  }
  act(id, () => startCheckout({ planId: id, origin: location.origin }));
}

/** Team is business-only: switch the billing account to a business, then open Checkout. */
function checkoutTeam() {
  const id = bill.teamPlan;
  const isBusiness = getState().billing?.kind === 'business';
  act('switch', async () => {
    if (!isBusiness) {
      await switchToBusiness({ name: bill.businessName });
      update((st) => { st.billing = { ...(st.billing || {}), kind: 'business' }; });
    }
    return startCheckout({ planId: id, quantity: bill.seats, origin: location.origin });
  });
}

function manageBilling() {
  act('portal', () => openPortal({ origin: location.origin }));
}

function planCard(p, current) {
  const local = PLANS[FROM_REVENUE[p.id]];
  const label = p.name.replace(/^SCALVS\.ai\s+/, '');
  const paidNow = current && current !== 'scalvs_free';
  let action = '';
  if (p.id === current) action = '<button class="btn sm" disabled>Current plan</button>';
  else if (p.channel === 'sales_assisted') action = `<button class="btn ghost sm" data-action="plan" data-id="${esc(p.id)}" ${signedIn() ? '' : 'disabled'}>Contact sales</button>`;
  else if (!p.priceCents) action = paidNow ? `<button class="btn ghost sm" data-action="plan" data-id="${esc(p.id)}" ${bill.busy ? 'disabled' : ''}>Downgrade</button>` : '';
  else {
    action = `<button class="btn sm primary" data-action="plan" data-id="${esc(p.id)}" ${!signedIn() || bill.busy ? 'disabled' : ''}>${
      bill.busy === p.id ? 'Opening checkout…' : paidNow ? 'Change plan' : 'Subscribe'}</button>`;
  }
  return `
      <div class="plan ${p.id === current ? 'sel' : ''}">
        <strong>${esc(label)}</strong>
        <span class="small">${esc(p.channel === 'sales_assisted' ? 'Contact sales' : formatPrice(p))}${p.trialDays ? ` · ${p.trialDays}-day trial` : ''}</span>
        ${local ? `<span class="small">${local.agents}${p.id === 'scalvs_team' ? '+' : ''} active agents</span>
        <span class="small muted">${esc(local.workflow)} workflows</span>
        <span class="small muted">Ads: ${esc(local.ads)}</span>
        <span class="small muted">${esc(local.deploy)}</span>` : ''}
        ${businessOnly(p) ? '<span class="small muted">For businesses</span>' : ''}
        ${action}
      </div>`;
}

function teamStep(s) {
  const p = bill.plans?.find((x) => x.id === bill.teamPlan);
  if (!p) return '';
  const isBusiness = s.billing?.kind === 'business';
  return `
    <div class="notice small" id="team-step">
      <p><strong>${esc(p.name)} is for businesses.</strong> ${isBusiness ? 'Choose how many seats you need, then check out.'
        : 'First switch your billing account to a business. You keep the same Cumulus ID.'}</p>
      <div class="row gap wrap">
        ${isBusiness ? '' : `<label class="small">Business name <input name="business-name" autocomplete="organization" maxlength="200" value="${esc(bill.businessName)}"></label>`}
        ${p.perSeat ? `<label class="small">Seats <input name="seats" type="number" min="1" max="10000" step="1" value="${bill.seats}"></label>` : ''}
        <button class="btn sm primary" data-action="team-checkout" ${bill.busy ? 'disabled' : ''}>${
          bill.busy === 'switch' ? 'Opening checkout…' : isBusiness ? 'Continue to checkout' : 'Switch to business and continue'}</button>
        <button class="btn ghost sm" data-action="team-cancel">Cancel</button>
      </div>
    </div>`;
}

function plansPanel(s) {
  const current = currentPlanId(s);
  const ent = s.billing?.entitlement;
  const currentName = bill.plans?.find((p) => p.id === current)?.name ?? current;
  return `
  <section class="panel" id="plans">
    <div class="panel-head"><h2>Plans</h2>${signedIn()
      ? `<button class="btn ghost sm" data-action="portal" ${bill.busy ? 'disabled' : ''}>${bill.busy === 'portal' ? 'Opening…' : 'Manage billing'}</button>` : ''}</div>
    ${current ? `<p class="small">Current plan: <strong>${esc(currentName)}</strong>${ent?.status ? ` <span class="tag">${esc(ent.status.replace(/_/g, ' '))}</span>` : ''}${ent?.seats > 1 ? ` · ${ent.seats} seats` : ''}</p>` : ''}
    ${bill.plans ? `<div class="plans">${bill.plans.map((p) => planCard(p, current)).join('')}</div>`
      : bill.catalogError ? `<p class="small">${esc(bill.catalogError)} <button class="btn ghost sm" data-action="plans-retry">Try again</button></p>`
        : '<p class="small muted">Loading plans…</p>'}
    ${teamStep(s)}
    ${signedIn() ? '' : `
    <div class="row gap wrap"><span class="small">Sign in with Cumulus ID to subscribe.</span>
      <button class="btn sm primary" data-action="cid-signin">Sign in with Cumulus ID</button>
      <button class="btn ghost sm" data-action="cid-create">Create a Cumulus ID</button></div>`}
    ${bill.error ? `<p class="small" role="alert">${esc(bill.error)}</p>` : ''}
    <p class="small muted">Paid plans check out securely with Stripe. Cancel or change any time from Manage billing.</p>
  </section>`;
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

  <firm-suite class="firm" product="scalvs"></firm-suite>

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

  ${plansPanel(s)}

  <p class="center"><button class="btn ghost sm" data-action="reset">Reset prototype data</button></p>`;
}

export function bind(root) {
  // Keep typed text across re-renders.
  root.addEventListener('input', (e) => {
    if (e.target.name === 'business-name') bill.businessName = e.target.value;
    else if (e.target.name === 'seats') bill.seats = Math.max(1, Math.min(10000, Math.floor(Number(e.target.value) || 1)));
  });
  if (!bill.plans) loadPlans();
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
    } else if (action === 'team-checkout') {
      checkoutTeam();
    } else if (action === 'team-cancel') {
      bill.teamPlan = null;
      rerender();
    } else if (action === 'plans-retry') {
      loadPlans();
    } else if (action === 'cid-signin') {
      window.CumulusID?.signIn();
    } else if (action === 'cid-create') {
      window.CumulusID?.create();
    } else if (action === 'reset') {
      if (confirm('Reset all prototype data?')) { reset(); toast('Prototype reset'); }
    }
  });
}

