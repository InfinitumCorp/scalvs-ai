// Infinitum Data Exchange (prototype, product-agnostic, no DOM).
//
// People create data by using Infinitum products. With their explicit,
// per-category and per-buyer consent, Infinitum sells it as de-identified,
// pooled segments to ad platforms, data brokers and researchers, and pays the
// person their share in tokens. Everything here is simulated: no data leaves
// the browser and no tokens or money move.
//
// Rules enforced in code, not just in copy:
//   - Nothing is sold without consent for that exact category AND buyer type.
//   - Consent starts off and can be withdrawn at any time; withdrawal stops
//     future sales (it cannot recall a sale that already happened).
//   - A Global Privacy Control signal is treated as an opt-out of every sale.
//   - Categories on the never-sold list do not exist in the exchange at all.
//   - Products outside EXCHANGE_PRODUCTS never contribute data.

export const BUYERS = [
  { id: 'ads', name: 'Ad platforms', desc: 'Audience segments for ad targeting and measurement.', rate: 1.0 },
  { id: 'brokers', name: 'Data brokers', desc: 'Pooled segments resold to marketers.', rate: 0.8 },
  { id: 'research', name: 'Research & analytics', desc: 'Market and trend studies in aggregate.', rate: 0.6 },
];

// usdPerPoint is the simulated gross price of one contribution point.
export const CATEGORIES = [
  { id: 'usage', name: 'Product usage', desc: 'Which features you use and how often. Counts only.', usdPerPoint: 0.01 },
  { id: 'interests', name: 'Interests & topics', desc: 'Broad topic labels from your tasks and forecasts (for example "B2B software"). Never the text itself.', usdPerPoint: 0.05 },
  { id: 'intent', name: 'Purchase intent', desc: 'Product categories you research or compare.', usdPerPoint: 0.12 },
  { id: 'region', name: 'Coarse region', desc: 'Country and state only. Never precise location.', usdPerPoint: 0.02 },
];

export const NEVER_SOLD = [
  'The content of your messages, documents, prompts and agent results',
  'Precise location',
  'Face, voice and other biometric data (including ei·det·ic)',
  'Health, financial-account and government ID information',
  'Anything from ODIN° or a military edition',
  'Data from anyone under 18',
];

// Consumer products that can contribute. Defense, identity and infrastructure
// products are excluded by design.
export const EXCHANGE_PRODUCTS = [
  'SCALVS.ai', '+SPCTR', 'METATRON¹⁰⁰', '/CNDCTR/', 'VEIL</>', 'FABRIC', 'Cumulus://Cloud',
  '[HRVST]', 'E(O)N', '#THRONE', 'FIRM Wallet',
];
export const EXCLUDED_PRODUCTS = [
  'ODIN°', '>_ARGUS', 'DAEMON', 'POLLEN', 'ORBIS', 'SLUG', 'Flower', 'ÆTHER', 'ei·det·ic', 'Firmament Network',
];

export const SHARE = 0.7;        // the person's share of every sale
export const SCLV_PER_USD = 10;  // simulated conversion for payouts
export const MIN_COHORT = 1000;  // segments are only sold pooled with at least this many people

const INTENT = /\b(compare|comparison|vs\.?|versus|best|buy|price|pricing|cost|vendor|alternative|review)\b/i;

export function emptyExchange() {
  return { consent: {}, sold: {}, receipts: [] };
}

export function ensureExchange(wallet) {
  if (!wallet.exchange) wallet.exchange = emptyExchange();
  return wallet.exchange;
}

const key = (category, buyer) => `${category}:${buyer}`;
export const hasConsent = (ex, category, buyer) => ex.consent[key(category, buyer)] === true;

export function setConsent(ex, category, buyer, on) {
  if (!CATEGORIES.some((c) => c.id === category) || !BUYERS.some((b) => b.id === buyer)) return false;
  if (on) ex.consent[key(category, buyer)] = true;
  else delete ex.consent[key(category, buyer)];
  return true;
}

export function withdrawAll(ex) {
  ex.consent = {};
}

// Credits points for activity in contributing products, once per item and
// milestone, so pruning old runs never takes points away.
export function collect(state, ex) {
  ex.points ??= {};
  ex.seen ??= [];
  const seen = new Set(ex.seen);
  const add = (cat, n) => { ex.points[cat] = (ex.points[cat] || 0) + n; };
  const credit = (id, kind, fn) => { const k = `${id}:${kind}`; if (!seen.has(k)) { seen.add(k); fn(); } };
  const items = [
    ...(state.runs || []).filter((r) => EXCHANGE_PRODUCTS.includes(r.product || 'SCALVS.ai'))
      .map((r) => ({ id: r.id, done: r.status === 'completed', text: r.task, usage: 3 })),
    ...(state.forecasts || []).filter((f) => EXCHANGE_PRODUCTS.includes(f.job?.product))
      .map((f) => ({ id: f.id, done: f.job.status === 'completed', text: f.job.question, usage: 5 })),
  ];
  for (const it of items) {
    credit(it.id, 'use', () => {
      add('usage', it.usage);
      if (INTENT.test(it.text || '')) add('intent', 2);
    });
    if (it.done) credit(it.id, 'done', () => add('interests', 2));
  }
  if (items.length) credit('account', 'region', () => add('region', 1));
  ex.seen = [...seen].slice(-500);
  return ex.points;
}

export function available(state, ex) {
  const earned = collect(state, ex);
  return Object.fromEntries(CATEGORIES.map((c) => [c.id, Math.max(0, (earned[c.id] || 0) - (ex.sold[c.id] || 0))]));
}

// What a sale to one buyer type would contain and pay. It only credits new
// activity (see collect); it never sells or changes consent.
export function quoteSale(state, ex, buyerId, { gpc = false } = {}) {
  const buyer = BUYERS.find((b) => b.id === buyerId);
  if (!buyer) return { blocked: 'Unknown buyer.', lines: [] };
  if (gpc) return { blocked: 'Your browser sends Global Privacy Control, so nothing is sold.', lines: [] };
  const avail = available(state, ex);
  const lines = CATEGORIES
    .filter((c) => hasConsent(ex, c.id, buyerId) && avail[c.id] > 0)
    .map((c) => {
      const grossUsd = round(avail[c.id] * c.usdPerPoint * buyer.rate);
      const shareUsd = round(grossUsd * SHARE);
      return { category: c.id, name: c.name, points: avail[c.id], grossUsd, shareUsd, sclv: round(shareUsd * SCLV_PER_USD) };
    });
  if (!lines.length) {
    const anyConsent = CATEGORIES.some((c) => hasConsent(ex, c.id, buyerId));
    return { blocked: anyConsent ? 'No new data to sell yet. Use the products and try again.' : `You have not allowed any data to be sold to ${buyer.name.toLowerCase()}.`, lines: [] };
  }
  return { buyer, lines, sclv: round(lines.reduce((n, l) => n + l.sclv, 0)), blocked: null };
}

// Records a quoted sale: marks points as sold and keeps a receipt.
export function applySale(ex, quote, now = Date.now()) {
  if (quote.blocked || !quote.lines.length) return 0;
  for (const l of quote.lines) ex.sold[l.category] = (ex.sold[l.category] || 0) + l.points;
  ex.receipts.unshift({ at: now, buyer: quote.buyer.id, lines: quote.lines, sclv: quote.sclv });
  ex.receipts = ex.receipts.slice(0, 50);
  return quote.sclv;
}

const round = (n) => Math.round(n * 100) / 100;
