// Connector vault: who is connected to what, and their tokens.
//
// - A visitor is identified by an HttpOnly session cookie (random 256-bit id). There are
//   no SCALVS.ai accounts yet, so whoever holds the cookie owns the connections.
// - Records live in Workers KV (binding CONNECT) under sha256(session id), sealed with
//   AES-GCM using CONNECT_SECRET, so neither KV keys nor values expose cookies or tokens.
// - Without a KV binding (npm run dev, tests) an in-memory store is used.

const COOKIE = 'scalvs_sid';
const enc = new TextEncoder();
const dec = new TextDecoder();

export const cfg = (env, name) => env?.[name] ?? (typeof process !== 'undefined' ? process.env?.[name] : undefined);

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
export const randomId = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256(text) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))));
}

// ---------- session cookie ----------
export function readSession(request) {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{43})(?:;|$)`));
  return m ? m[1] : null;
}
export function sessionCookie(sid, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`;
}

// ---------- storage ----------
const memory = new Map();
const memoryKv = {
  async get(k) { const v = memory.get(k); if (!v) return null; if (v.exp && v.exp < Date.now()) { memory.delete(k); return null; } return v.value; },
  async put(k, value, opts = {}) { memory.set(k, { value, exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 }); },
  async delete(k) { memory.delete(k); },
};
const kv = (env) => env?.CONNECT || memoryKv;

let devKey;
async function key(env) {
  const secret = cfg(env, 'CONNECT_SECRET');
  if (!secret) {
    // Development only: an ephemeral key, so stored tokens die with the process.
    if (env?.CONNECT) throw new Error('CONNECT_SECRET is not set');
    devKey ??= crypto.getRandomValues(new Uint8Array(32));
    return crypto.subtle.importKey('raw', devKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`scalvs-connect:${secret}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(env, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return b64url(out);
}
async function open(env, text) {
  const data = unb64url(text);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, await key(env), data.slice(12));
  return JSON.parse(dec.decode(pt));
}

const emptyRecord = () => ({ connections: {}, custom: [] });

export async function loadRecord(env, sid) {
  const raw = await kv(env).get(`sess:${await sha256(sid)}`);
  if (!raw) return emptyRecord();
  try { return { ...emptyRecord(), ...(await open(env, raw)) }; } catch { return emptyRecord(); }
}
export async function saveRecord(env, sid, record) {
  await kv(env).put(`sess:${await sha256(sid)}`, await seal(env, record), { expirationTtl: 60 * 60 * 24 * 365 });
}

// Pending OAuth sign-ins, keyed by the `state` parameter; single use, 10 minutes.
export async function putPending(env, state, data) {
  await kv(env).put(`oauth:${await sha256(state)}`, await seal(env, data), { expirationTtl: 600 });
}
export async function takePending(env, state) {
  const k = `oauth:${await sha256(state)}`;
  const raw = await kv(env).get(k);
  if (!raw) return null;
  await kv(env).delete(k);
  try { return await open(env, raw); } catch { return null; }
}

// ---------- outbound URL guard ----------
// Custom connectors and OAuth metadata point the Worker at URLs from the internet:
// only public https endpoints are allowed. SCALVS_ALLOW_LOCAL=1 (tests, local dev)
// also allows http://localhost.
const PRIVATE_V4 = [/^10\./, /^127\./, /^0\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
export function checkUrl(value, env) {
  let u;
  try { u = new URL(value); } catch { throw new Error('Enter a full URL, starting with https://'); }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (local && cfg(env, 'SCALVS_ALLOW_LOCAL') === '1') return u;
  if (u.protocol !== 'https:') throw new Error('Connector URLs must use https://');
  if (u.username || u.password) throw new Error('Put credentials in the token field, not in the URL');
  if (local || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')
    || PRIVATE_V4.some((r) => r.test(host)) || host.includes(':')) {
    throw new Error('That address is not a public server');
  }
  return u;
}
