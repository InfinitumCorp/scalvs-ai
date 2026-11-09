// Google OAuth 2.0 (PKCE + state) and AES-GCM token storage for Workspace
// connectors. Off unless GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.
// Tokens never go in the repo, in localStorage, or in a URL.

export const SESSION_COOKIE = 'scalvs_google';
export const TXN_COOKIE = 'scalvs_google_oauth';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
export const TXN_MAX_AGE = 600;

// Least privilege per connector. gmail.compose is the narrowest scope that
// can create drafts; callers must not use it to send mail.
export const GOOGLE_CONNECTORS = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
  ],
  drive: ['https://www.googleapis.com/auth/drive.readonly'],
  calendar: ['https://www.googleapis.com/auth/calendar.events'],
};

export const googleConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function b64urlToBytes(value) {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function misconfigured(message) {
  const err = new Error(message);
  err.code = 'misconfigured';
  return err;
}

function decodeKey(input) {
  const s = String(input || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  return b64urlToBytes(s);
}

async function tokenKey() {
  let raw;
  if (process.env.GOOGLE_TOKEN_KEY) {
    try { raw = decodeKey(process.env.GOOGLE_TOKEN_KEY); } catch { throw misconfigured('bad token key'); }
  } else {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      textEncoder.encode(`scalvs.google.token.v1\0${process.env.GOOGLE_CLIENT_SECRET || ''}`),
    );
    raw = new Uint8Array(digest);
  }
  if (raw.byteLength !== 32) throw misconfigured('bad token key');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function seal(purpose, value) {
  const key = await tokenKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: textEncoder.encode(purpose) },
    key,
    textEncoder.encode(JSON.stringify(value)),
  );
  return `v1.${bytesToB64url(iv)}.${bytesToB64url(new Uint8Array(cipher))}`;
}

export async function open(purpose, token) {
  if (typeof token !== 'string' || token.length > 8000 || !token.startsWith('v1.')) return null;
  const [, ivPart, cipherPart] = token.split('.');
  if (!ivPart || !cipherPart) return null;
  let iv;
  let cipher;
  try {
    iv = b64urlToBytes(ivPart);
    cipher = b64urlToBytes(cipherPart);
  } catch { return null; }
  if (iv.byteLength !== 12) return null;
  try {
    const key = await tokenKey();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: textEncoder.encode(purpose) },
      key,
      cipher,
    );
    return JSON.parse(textDecoder.decode(plain));
  } catch (err) {
    if (err?.code === 'misconfigured') throw err;
    return null;
  }
}

export function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

export function cookieHeader(name, value, request, { maxAge = SESSION_MAX_AGE, clear = false } = {}) {
  const secure = new URL(request.url).protocol === 'https:';
  const parts = [
    `${name}=${clear ? '' : value}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${clear ? 0 : maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function redirectUri(request) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const url = new URL(request.url);
  return `${url.origin}/api/google/callback`;
}

export async function createPkce() {
  const verifier = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(verifier));
  const challenge = bytesToB64url(new Uint8Array(digest));
  const state = bytesToB64url(crypto.getRandomValues(new Uint8Array(16)));
  return { verifier, challenge, state };
}

export function authorizeUrl({ clientId, redirect, state, challenge, scopes }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export function safeEqual(a, b) {
  const left = textEncoder.encode(String(a ?? ''));
  const right = textEncoder.encode(String(b ?? ''));
  if (left.length !== right.length || left.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

export function applyToken(prev, token, connector) {
  const scopes = typeof token?.scope === 'string' && token.scope.trim()
    ? token.scope.split(/\s+/).filter(Boolean)
    : [...(prev?.scopes || [])];
  const connectors = new Set(Array.isArray(prev?.connectors) ? prev.connectors : []);
  if (connector) connectors.add(connector);
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token || prev?.refresh_token || '',
    expiry: Date.now() + (Number(token.expires_in) || 3600) * 1000,
    scopes,
    connectors: [...connectors],
  };
}

export function hasConnector(session, connector) {
  const need = GOOGLE_CONNECTORS[connector];
  if (!need || !session?.connectors?.includes(connector)) return false;
  return need.every((scope) => session.scopes?.includes(scope));
}

export async function exchangeCode({ code, verifier, redirect }) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      code_verifier: verifier,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirect,
      grant_type: 'authorization_code',
    }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token) {
    const err = new Error('token exchange failed');
    err.status = response.status;
    throw err;
  }
  return data;
}

export async function refreshToken(session) {
  if (!session?.refresh_token) {
    const err = new Error('consent required');
    err.code = 'consent_required';
    throw err;
  }
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refresh_token,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  });
  const data = await response.json().catch(() => null);
  if (response.status === 400 || response.status === 401) {
    const err = new Error('consent required');
    err.code = 'consent_required';
    throw err;
  }
  if (!response.ok || !data?.access_token) {
    const err = new Error('refresh failed');
    err.status = response.status;
    throw err;
  }
  return applyToken(session, data, null);
}

export async function revokeToken(session) {
  const token = session?.refresh_token || session?.access_token;
  if (!token) return;
  await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  }).catch(() => {});
}

const GMAIL_ID = /^[A-Za-z0-9]{1,80}$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function oneLine(value, max) {
  return String(value ?? '').replace(/[\r\n\0]/g, ' ').trim().slice(0, max);
}

export function validEmail(value) {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value) && value.length <= 254;
}

function encodeHeader(name, value) {
  if (/^[\x20-\x7E]*$/.test(value)) return `${name}: ${value}`;
  let bin = '';
  for (const b of textEncoder.encode(value)) bin += String.fromCharCode(b);
  return `${name}: =?UTF-8?B?${btoa(bin)}?=`;
}

export function rfc822({ to, subject, body }) {
  const lines = [
    encodeHeader('To', to),
    encodeHeader('Subject', subject),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ];
  return bytesToB64url(textEncoder.encode(lines.join('\r\n')));
}

export function gmailThreadId(id) {
  const value = String(id ?? '');
  return GMAIL_ID.test(value) ? value : null;
}

export function driveFileId(id) {
  const value = String(id ?? '');
  return DRIVE_ID.test(value) ? value : null;
}

export function parseTime(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(raw)) return null;
  const withZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const ms = Date.parse(withZone);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function driveListQuery(name) {
  const safe = oneLine(name, 80).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return safe ? `trashed = false and name contains '${safe}'` : 'trashed = false';
}

function walkParts(part, into) {
  if (!part || typeof part !== 'object') return;
  if (part.mimeType === 'text/plain' && part.body?.data) into.push(part.body.data);
  if (Array.isArray(part.parts)) for (const child of part.parts) walkParts(child, into);
}

export function gmailPlainText(payload) {
  const chunks = [];
  walkParts(payload, chunks);
  if (!chunks.length && payload?.body?.data && String(payload.mimeType || '').startsWith('text/plain')) chunks.push(payload.body.data);
  const text = chunks.map((data) => {
    try { return textDecoder.decode(b64urlToBytes(data)); } catch { return ''; }
  }).join('\n').trim();
  return text.slice(0, 8000);
}

export function headerMap(headers) {
  const out = {};
  for (const header of headers || []) {
    if (typeof header?.name === 'string') out[header.name.toLowerCase()] = oneLine(header.value, 300);
  }
  return out;
}
