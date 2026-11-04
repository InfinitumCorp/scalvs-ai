// Tiny persistent store. All state lives in the browser (localStorage);
// balances and rewards are simulated — no blockchain, no real tokens.

import { PLANS, TEMPLATES } from './data.js';

const KEY = 'scalvs.state.v1';
const listeners = new Set();

export const uid = (prefix = 'id') => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

function seed() {
  const researcher = TEMPLATES[0];
  const writer = TEMPLATES[1];
  return {
    plan: 'free',
    agents: [
      {
        id: uid('agt'), name: 'Atlas', template: researcher.id, role: researcher.role,
        instructions: 'Cite sources inline. Flag anything older than 12 months.',
        tools: [...researcher.tools], memory: true, approval: false, schedule: 'none', createdAt: Date.now(),
      },
      {
        id: uid('agt'), name: 'Quill', template: writer.id, role: writer.role,
        instructions: 'Plain, confident tone. No jargon. Keep drafts under 400 words.',
        tools: [...writer.tools], memory: true, approval: true, schedule: 'none', createdAt: Date.now(),
      },
    ],
    teams: [],
    runs: [],
    connections: { cumulus: true, cndctr: true, firm: true },
    vault: [
      { id: uid('mem'), text: 'Organization: Infinitum Corporation, Washington, D.C.', products: ['SCALVS.ai', '+SPCTR', 'VEIL</>'] },
      { id: uid('mem'), text: 'Audience: business and government decision-makers.', products: ['SCALVS.ai'] },
    ],
    wallet: {
      creditsUsed: 0,
      activity: 0,
      sclv: 0,
      sclvThisWeek: 0,
      usd: 0,
      adsOptIn: false,
      adsDays: 0,
      datasets: {},
      ledger: [],
    },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...seed(), ...JSON.parse(raw) };
  } catch { /* storage unavailable: fall back to memory */ }
  return seed();
}

let state = load();

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

export const getState = () => state;

export function update(mutator) {
  mutator(state);
  persist();
  listeners.forEach((fn) => fn(state));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function reset() {
  state = seed();
  persist();
  listeners.forEach((fn) => fn(state));
}

export const plan = () => PLANS[state.plan];

export function addLedger(entry) {
  state.wallet.ledger.unshift({ id: uid('tx'), at: Date.now(), ...entry });
  state.wallet.ledger = state.wallet.ledger.slice(0, 60);
}
