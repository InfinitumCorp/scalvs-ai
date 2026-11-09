// Google Workspace connectors stay off without OAuth client credentials.
// With credentials, PKCE state is checked and tokens are stored encrypted.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { handle } from '../api/google.js';
import { driveListQuery, open, seal, SESSION_COOKIE, TXN_COOKIE } from '../api/_google.js';
import { connectorMode } from '../src/google.js';

const originalFetch = globalThis.fetch;
const KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_TOKEN_KEY', 'GOOGLE_REDIRECT_URI'];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function enable() {
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  delete process.env.GOOGLE_TOKEN_KEY;
  delete process.env.GOOGLE_REDIRECT_URI;
}

function req(path, { method = 'GET', body, cookie, origin = 'https://scalvs.test' } = {}) {
  const headers = {};
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://scalvs.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function cookieValue(response, name) {
  const header = response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
  if (!header) return '';
  return header.split(';')[0].slice(name.length + 1);
}

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

async function sessionCookie(connectors = ['gmail'], scopes = GMAIL_SCOPES, extra = {}) {
  enable();
  const sealed = await seal(SESSION_COOKIE, {
    access_token: 'ya29.test-access-token',
    refresh_token: 'refresh-test',
    expiry: Date.now() + 60 * 60 * 1000,
    scopes,
    connectors,
    ...extra,
  });
  return `${SESSION_COOKIE}=${sealed}`;
}

test('connectors are disabled until Google OAuth credentials are set', async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  let called = false;
  globalThis.fetch = async () => { called = true; return Response.json({}); };
  const status = await handle(req('/api/google/status'));
  assert.equal(status.status, 200);
  assert.equal((await status.json()).configured, false);
  const connect = await handle(req('/api/google/connect?connector=gmail'));
  assert.equal(connect.status, 503);
  assert.equal((await connect.json()).configured, false);
  const draft = await handle(req('/api/google/gmail/draft', {
    method: 'POST',
    body: { to: 'a@example.com', subject: 'Hi', body: 'Hello' },
  }));
  assert.equal(draft.status, 503);
  const drive = await handle(req('/api/google/drive/list', { method: 'POST', body: {} }));
  assert.equal(drive.status, 503);
  const calendar = await handle(req('/api/google/calendar/create', {
    method: 'POST',
    body: { summary: 'Standup', start: '2026-11-09T15:00:00Z', end: '2026-11-09T15:30:00Z' },
  }));
  assert.equal(calendar.status, 503);
  assert.equal(called, false);
});

test('the worker serves the disabled Google status without touching static assets', async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  const response = await worker.fetch(new Request('https://scalvs.test/api/google/status'), {
    ASSETS: { fetch() { throw new Error('assets should not be fetched'); } },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).configured, false);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('the worker keeps the PKCE cookie on the Google redirect', async () => {
  enable();
  const response = await worker.fetch(new Request('https://scalvs.test/api/google/connect?connector=calendar'), {
    ASSETS: { fetch() { throw new Error('assets should not be fetched'); } },
  });
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get('location')).hostname, 'accounts.google.com');
  const cookie = response.headers.getSetCookie().find((line) => line.startsWith(`${TXN_COOKIE}=`));
  assert.match(cookie, /HttpOnly/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('connect starts PKCE against Google and does not put the secret in the URL', async () => {
  enable();
  const response = await handle(req('/api/google/connect?connector=gmail'));
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.hostname, 'accounts.google.com');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(location.searchParams.get('code_challenge'));
  assert.ok(location.searchParams.get('state'));
  assert.equal(location.searchParams.get('code_verifier'), null);
  assert.equal(location.searchParams.get('client_id'), 'test-client-id');
  assert.equal(location.search.includes('test-client-secret'), false);
  const scopes = location.searchParams.get('scope').split(' ');
  assert.ok(scopes.includes('https://www.googleapis.com/auth/gmail.readonly'));
  assert.ok(scopes.includes('https://www.googleapis.com/auth/gmail.compose'));
  assert.equal(scopes.some((scope) => scope.includes('drive') || scope.includes('calendar') || scope.includes('gmail.modify')), false);
  const cookie = response.headers.getSetCookie().find((line) => line.startsWith(`${TXN_COOKIE}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.equal(cookie.includes('code_verifier'), false);
});

test('callback rejects a mismatched state and stores a granted token encrypted', async () => {
  enable();
  const start = await handle(req('/api/google/connect?connector=drive'));
  const txn = cookieValue(start, TXN_COOKIE);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const mismatch = await handle(req(`/api/google/callback?code=authcode123&state=${'x'.repeat(20)}`, {
    cookie: `${TXN_COOKIE}=${txn}`,
  }));
  assert.match(mismatch.headers.get('location'), /google=error/);
  assert.equal(cookieValue(mismatch, SESSION_COOKIE), '');

  let tokenBody = '';
  globalThis.fetch = async (_url, init) => {
    tokenBody = init.body.toString();
    return Response.json({
      access_token: 'ya29.test-access-token',
      refresh_token: 'refresh-test',
      expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
    });
  };
  const ok = await handle(req(`/api/google/callback?code=authcode123&state=${state}`, {
    cookie: `${TXN_COOKIE}=${txn}`,
  }));
  assert.equal(ok.headers.get('location'), '/#/connect?google=connected');
  assert.equal(ok.headers.get('location').includes('authcode123'), false);
  assert.match(tokenBody, /code_verifier=/);
  assert.match(tokenBody, /grant_type=authorization_code/);
  const sealed = cookieValue(ok, SESSION_COOKIE);
  assert.ok(sealed);
  assert.equal(sealed.includes('ya29.test-access-token'), false);
  assert.equal(sealed.includes('test-client-secret'), false);
  const session = await open(SESSION_COOKIE, sealed);
  assert.equal(session.access_token, 'ya29.test-access-token');
  assert.deepEqual(session.connectors, ['drive']);
  assert.equal(await open(TXN_COOKIE, sealed), null);
});

test('an enabled session can draft mail without sending, and list Drive and Calendar', async () => {
  const cookie = await sessionCookie();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/drafts')) return Response.json({ id: 'draft-1' });
    if (String(url).includes('gmail.googleapis.com') && String(url).includes('/threads?')) {
      return Response.json({ threads: [{ id: 'abc123', snippet: 'Hello there' }] });
    }
    if (String(url).includes('/threads/abc123')) {
      return Response.json({
        messages: [{ payload: { headers: [{ name: 'Subject', value: 'Hello' }, { name: 'From', value: 'Ada <ada@example.com>' }] } }],
        snippet: 'Hello there',
      });
    }
    return Response.json({});
  };

  const drafted = await handle(req('/api/google/gmail/draft', {
    method: 'POST',
    cookie,
    body: { to: 'a@example.com', subject: 'Hi', body: 'Hello', send: false },
  }));
  assert.equal(drafted.status, 200);
  assert.deepEqual(await drafted.json(), { id: 'draft-1', sent: false });
  assert.equal(calls[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer ya29.test-access-token');
  assert.equal(calls.some((call) => call.url.includes('/send')), false);

  const refused = await handle(req('/api/google/gmail/draft', {
    method: 'POST',
    cookie,
    body: { to: 'a@example.com', subject: 'Hi', body: 'Hello', send: true },
  }));
  assert.equal(refused.status, 400);

  const cross = await handle(req('/api/google/gmail/list', { method: 'POST', cookie, origin: 'https://evil.test', body: {} }));
  assert.equal(cross.status, 403);

  calls.length = 0;
  const listed = await handle(req('/api/google/gmail/list', { method: 'POST', cookie, body: {} }));
  assert.equal(listed.status, 200);
  const threads = (await listed.json()).threads;
  assert.equal(threads[0].subject, 'Hello');
  assert.equal(threads[0].from, 'Ada <ada@example.com>');

  const driveCookie = await sessionCookie(['drive'], ['https://www.googleapis.com/auth/drive.readonly']);
  calls.length = 0;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/files?')) return Response.json({ files: [{ id: 'file_1', name: 'Notes.txt', mimeType: 'text/plain', size: '12' }] });
    if (String(url).includes('alt=media')) return new Response('hello file');
    return Response.json({ id: 'file_1', name: 'Notes.txt', mimeType: 'text/plain', size: '12' });
  };
  const files = await handle(req('/api/google/drive/list', { method: 'POST', cookie: driveCookie, body: { query: "notes" } }));
  assert.equal(files.status, 200);
  assert.equal((await files.json()).files[0].name, 'Notes.txt');
  assert.equal(new URL(calls[0]).searchParams.get('q'), "trashed = false and name contains 'notes'");
  const read = await handle(req('/api/google/drive/read', { method: 'POST', cookie: driveCookie, body: { id: 'file_1' } }));
  assert.equal((await read.json()).file.text, 'hello file');

  const calendarCookie = await sessionCookie(['calendar'], ['https://www.googleapis.com/auth/calendar.events']);
  let created;
  globalThis.fetch = async (url, init) => {
    created = { url: String(url), body: init?.body };
    return Response.json({ id: 'evt1', summary: 'Standup', start: { dateTime: '2026-11-09T15:00:00.000Z' }, end: { dateTime: '2026-11-09T15:30:00.000Z' } });
  };
  const event = await handle(req('/api/google/calendar/create', {
    method: 'POST',
    cookie: calendarCookie,
    body: { summary: 'Standup', start: '2026-11-09T15:00:00Z', end: '2026-11-09T15:30:00Z', attendees: ['a@example.com'] },
  }));
  assert.equal(event.status, 200);
  assert.equal(created.url, 'https://www.googleapis.com/calendar/v3/calendars/primary/events');
  const payload = JSON.parse(created.body);
  assert.equal(payload.summary, 'Standup');
  assert.equal(payload.attendees, undefined);
  assert.equal((await event.json()).id, 'evt1');
});

test('a Google 429 is retryable and the upstream body is not returned', async () => {
  const cookie = await sessionCookie();
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'secret user mailbox' } }), { status: 429 });
  const response = await handle(req('/api/google/gmail/list', { method: 'POST', cookie, body: {} }));
  assert.equal(response.status, 429);
  const text = await response.text();
  assert.match(text, /rate limiting/i);
  assert.equal(text.includes('secret user mailbox'), false);
  assert.equal(text.includes('ya29.test-access-token'), false);
});

test('an expired access token is refreshed and a bad key does not unlock the cookie', async () => {
  enable();
  const sealed = await seal(SESSION_COOKIE, {
    access_token: 'ya29.old-token',
    refresh_token: 'refresh-test',
    expiry: Date.now() - 1000,
    scopes: GMAIL_SCOPES,
    connectors: ['gmail'],
  });
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'ya29.new-token', expires_in: 3600 });
    }
    return Response.json({ threads: [] });
  };
  const response = await handle(req('/api/google/gmail/list', {
    method: 'POST',
    cookie: `${SESSION_COOKIE}=${sealed}`,
    body: {},
  }));
  assert.equal(response.status, 200);
  assert.equal(urls[0], 'https://oauth2.googleapis.com/token');
  assert.equal(urls[1].startsWith('https://gmail.googleapis.com/'), true);
  const updated = await open(SESSION_COOKIE, cookieValue(response, SESSION_COOKIE));
  assert.equal(updated.access_token, 'ya29.new-token');
  assert.equal(updated.refresh_token, 'refresh-test');

  process.env.GOOGLE_TOKEN_KEY = 'zz';
  const broken = await handle(req('/api/google/status', { cookie: `${SESSION_COOKIE}=${sealed}` }));
  assert.equal(broken.status, 500);
  assert.equal((await broken.text()).includes('ya29'), false);
});

test('connector mode stays simulated until the server says Google is configured', () => {
  assert.deepEqual(connectorMode(null, 'gmail', true), { mode: 'simulated', on: true });
  assert.deepEqual(connectorMode({ configured: false }, 'drive', false), { mode: 'simulated', on: false });
  assert.deepEqual(connectorMode({ configured: true, connectors: { gmail: true } }, 'gmail', false), { mode: 'google', on: true });
  assert.deepEqual(connectorMode({ configured: true, connectors: {} }, 'slack', true), { mode: 'simulated', on: true });
});

test('Drive queries cannot break out of the name filter', () => {
  assert.equal(driveListQuery("a' or name contains 'b"), "trashed = false and name contains 'a\\' or name contains \\'b'");
});
