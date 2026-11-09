// Optional cross-device state. localStorage stays the default.
// Sync turns on only after the server reports state: true (DynamoDB configured).

import { getState, replaceState, stamp, subscribe } from './store.js';

const PROFILE = 'scalvs.profile';
const MAX_BYTES = 20 * 1024;
let stateOn = false;
let queueOn = false;
let started = false;
let timer = null;
let lastPushed = '';
let pushDelay = 2000;
let unsub = null;

export const remoteStateEnabled = () => stateOn;
export const queueEnabled = () => queueOn;

export function noteServiceFlags(data) {
  if (!data || typeof data !== 'object') return;
  if (data.queue === true) queueOn = true;
  if (data.state === true) stateOn = true;
}

export function enableRemoteState() {
  stateOn = true;
}

export function resetServicesForTests() {
  stateOn = false;
  queueOn = false;
  started = false;
  lastPushed = '';
  clearTimeout(timer);
  unsub?.();
  unsub = null;
}

export function profileId() {
  let id = localStorage.getItem(PROFILE);
  if (!/^[a-f0-9]{32}$/.test(id || '')) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(PROFILE, id);
  }
  return id;
}

export async function adoptProfile(id) {
  if (!/^[a-f0-9]{32}$/.test(id || '')) return false;
  localStorage.setItem(PROFILE, id);
  started = false;
  await startRemoteSync();
  return true;
}

export async function startRemoteSync() {
  if (!stateOn || started) return;
  started = true;
  try {
    const remote = await pull();
    if (remote?.state && Number(remote.updatedAt) > Number(getState().updatedAt || 0)) {
      lastPushed = JSON.stringify(remote.state);
      replaceState(remote.state);
    }
  } catch { /* keep this browser's copy */ }
  unsub?.();
  unsub = subscribe(() => schedulePush());
}

function schedulePush() {
  if (!stateOn) return;
  clearTimeout(timer);
  timer = setTimeout(() => { push().catch(() => {}); }, pushDelay);
}

async function pull() {
  const res = await fetch(`api/state?profile=${profileId()}`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data?.enabled || !data.state) return null;
  return data;
}

async function push() {
  const updatedAt = Date.now();
  const payload = { ...getState(), updatedAt };
  const encoded = JSON.stringify(payload);
  if (new TextEncoder().encode(encoded).byteLength > MAX_BYTES) return;
  if (encoded === lastPushed) return;
  stamp(updatedAt);
  const res = await fetch('api/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile: profileId(), updatedAt, state: { ...getState(), updatedAt } }),
  });
  if (res.ok) lastPushed = encoded;
}

export function setPushDelayForTests(ms) { pushDelay = ms; }
