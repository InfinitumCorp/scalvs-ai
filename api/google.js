// Google Workspace connectors (user OAuth). Off unless GOOGLE_CLIENT_ID and
// GOOGLE_CLIENT_SECRET are set.
//
//   GET  /api/google/status
//   GET  /api/google/connect?connector=gmail|drive|calendar
//   GET  /api/google/callback
//   POST /api/google/disconnect          { connector }
//   POST /api/google/gmail/list
//   POST /api/google/gmail/read          { id }
//   POST /api/google/gmail/draft         { to, subject, body }   (saves a draft; never sends)
//   POST /api/google/drive/list          { query? }
//   POST /api/google/drive/read          { id }
//   POST /api/google/calendar/list
//   POST /api/google/calendar/create     { summary, start, end, description?, location? }

import {
  GOOGLE_CONNECTORS, SESSION_COOKIE, SESSION_MAX_AGE, TXN_COOKIE, TXN_MAX_AGE,
  applyToken, authorizeUrl, cookieHeader, createPkce, driveFileId, driveListQuery,
  exchangeCode, gmailPlainText, gmailThreadId, googleConfigured, hasConnector,
  headerMap, oneLine, open, parseTime, readCookie, redirectUri, refreshToken,
  revokeToken, rfc822, safeEqual, seal, validEmail,
} from './_google.js';

const NEXT = {
  connected: '/#/connect?google=connected',
  denied: '/#/connect?google=denied',
  error: '/#/connect?google=error',
};

function json(body, status = 200, cookies = []) {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function redirect(location, cookies = []) {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}

function clearSession(request) {
  return cookieHeader(SESSION_COOKIE, '', request, { clear: true });
}

function clearTxn(request) {
  return cookieHeader(TXN_COOKIE, '', request, { clear: true });
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  return Boolean(origin) && origin === new URL(request.url).origin;
}

async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > 100_000) return { error: json({ error: 'Body too large' }, 413) };
  try {
    const text = await request.text();
    return { body: text ? JSON.parse(text) : {} };
  } catch {
    return { error: json({ error: 'Invalid JSON body' }, 400) };
  }
}

async function readTextCap(response, max) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let out = '';
  while (out.length < max) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  reader.cancel().catch(() => {});
  return out.slice(0, max);
}

async function loadSession(request) {
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return null;
  const session = await open(SESSION_COOKIE, raw);
  if (!session?.access_token || !Array.isArray(session.scopes)) return null;
  return session;
}

async function googleFetch(token, url, init = {}) {
  return fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
}

async function readGoogle(response) {
  const data = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403) {
    return { error: json({ error: 'Google denied this request. Reconnect the account.', code: 'consent_required' }, 401) };
  }
  if (response.status === 429) {
    return { error: json({ error: 'Google is rate limiting this account. Please retry shortly.' }, 429) };
  }
  if (!response.ok || data == null) {
    return { error: json({ error: `Google request failed (${response.status}). Please retry.` }, 502) };
  }
  return { data };
}

async function withConnector(request, connector, fn) {
  if (!googleConfigured()) return json({ configured: false, error: 'Google Workspace is not configured' }, 503);
  if (!sameOrigin(request)) return json({ error: 'Cross-origin request refused' }, 403);
  let session;
  try {
    session = await loadSession(request);
  } catch (err) {
    if (err?.code === 'misconfigured') return json({ error: 'Google token storage is misconfigured.' }, 500);
    return json({ error: 'Connect this Google account first.', code: 'consent_required' }, 401);
  }
  if (!hasConnector(session, connector)) {
    return json({ error: 'Connect this Google account first.', code: 'consent_required' }, 401);
  }
  let cookies = [];
  if (session.expiry - Date.now() < 60_000) {
    try {
      session = await refreshToken(session);
      cookies = [cookieHeader(SESSION_COOKIE, await seal(SESSION_COOKIE, session), request)];
    } catch (err) {
      if (err?.code === 'consent_required') {
        return json({ error: 'Connect this Google account first.', code: 'consent_required' }, 401, [clearSession(request)]);
      }
      return json({ error: 'Google authorization could not be refreshed. Please retry.' }, 502);
    }
  }
  try {
    const response = await fn(session.access_token);
    if (cookies.length && response instanceof Response) {
      const headers = new Headers(response.headers);
      for (const cookie of cookies) headers.append('set-cookie', cookie);
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  } catch {
    return json({ error: 'The Google request could not complete. Please retry.' }, 502);
  }
}

async function status(request) {
  const configured = googleConfigured();
  const connectors = { gmail: false, drive: false, calendar: false };
  if (!configured) return json({ ok: true, configured: false, connectors });
  try {
    const session = await loadSession(request);
    for (const id of Object.keys(connectors)) connectors[id] = hasConnector(session, id);
    return json({ ok: true, configured: true, connectors });
  } catch (err) {
    if (err?.code === 'misconfigured') return json({ error: 'Google token storage is misconfigured.' }, 500);
    return json({ ok: true, configured: true, connectors });
  }
}

async function connect(request) {
  if (!googleConfigured()) return json({ configured: false, error: 'Google Workspace is not configured' }, 503);
  const connector = new URL(request.url).searchParams.get('connector');
  const scopes = GOOGLE_CONNECTORS[connector];
  if (!scopes) return json({ error: 'Unknown connector' }, 400);
  try {
    const { verifier, challenge, state } = await createPkce();
    const txn = await seal(TXN_COOKIE, { state, verifier, connector, exp: Date.now() + TXN_MAX_AGE * 1000 });
    const location = authorizeUrl({
      clientId: process.env.GOOGLE_CLIENT_ID,
      redirect: redirectUri(request),
      state,
      challenge,
      scopes,
    });
    return redirect(location, [cookieHeader(TXN_COOKIE, txn, request, { maxAge: TXN_MAX_AGE })]);
  } catch (err) {
    if (err?.code === 'misconfigured') return json({ error: 'Google token storage is misconfigured.' }, 500);
    return redirect(NEXT.error);
  }
}

async function callback(request) {
  if (!googleConfigured()) return json({ configured: false, error: 'Google Workspace is not configured' }, 503);
  const url = new URL(request.url);
  const fail = (kind) => redirect(NEXT[kind] || NEXT.error, [clearTxn(request)]);
  if (url.searchParams.get('error')) return fail('denied');
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  if (code.length < 8 || code.length > 512 || state.length < 8 || state.length > 128) return fail('error');
  let txn;
  try {
    txn = await open(TXN_COOKIE, readCookie(request, TXN_COOKIE));
  } catch (err) {
    if (err?.code === 'misconfigured') return json({ error: 'Google token storage is misconfigured.' }, 500);
    return fail('error');
  }
  if (!txn || txn.exp < Date.now() || !safeEqual(txn.state, state) || !GOOGLE_CONNECTORS[txn.connector]) return fail('error');
  let token;
  try {
    token = await exchangeCode({ code, verifier: txn.verifier, redirect: redirectUri(request) });
  } catch {
    return fail('error');
  }
  let prev = null;
  try { prev = await loadSession(request); } catch { prev = null; }
  const session = applyToken(prev, token, null);
  if (!GOOGLE_CONNECTORS[txn.connector].every((scope) => session.scopes.includes(scope))) return fail('denied');
  session.connectors = [...new Set([...(prev?.connectors || []), txn.connector])];
  try {
    const sealed = await seal(SESSION_COOKIE, session);
    return redirect(NEXT.connected, [
      clearTxn(request),
      cookieHeader(SESSION_COOKIE, sealed, request),
    ]);
  } catch (err) {
    if (err?.code === 'misconfigured') return json({ error: 'Google token storage is misconfigured.' }, 500);
    return fail('error');
  }
}

async function disconnect(request) {
  if (!googleConfigured()) return json({ configured: false, error: 'Google Workspace is not configured' }, 503);
  if (!sameOrigin(request)) return json({ error: 'Cross-origin request refused' }, 403);
  const { body, error } = await readJson(request);
  if (error) return error;
  const connector = body?.connector;
  if (connector != null && !GOOGLE_CONNECTORS[connector]) return json({ error: 'Unknown connector' }, 400);
  let session = null;
  try { session = await loadSession(request); } catch { session = null; }
  if (!session) return json({ ok: true, connectors: { gmail: false, drive: false, calendar: false } }, 200, [clearSession(request)]);
  if (!connector) {
    await revokeToken(session);
    return json({ ok: true, connectors: { gmail: false, drive: false, calendar: false } }, 200, [clearSession(request)]);
  }
  session.connectors = session.connectors.filter((id) => id !== connector);
  if (!session.connectors.length) {
    await revokeToken(session);
    return json({ ok: true, connectors: { gmail: false, drive: false, calendar: false } }, 200, [clearSession(request)]);
  }
  const connectors = { gmail: false, drive: false, calendar: false };
  for (const id of session.connectors) if (hasConnector(session, id)) connectors[id] = true;
  try {
    return json({ ok: true, connectors }, 200, [cookieHeader(SESSION_COOKIE, await seal(SESSION_COOKIE, session), request)]);
  } catch (err) {
    if (err?.code === 'misconfigured') return json({ error: 'Google token storage is misconfigured.' }, 500);
    return json({ error: 'The Google request could not complete. Please retry.' }, 502);
  }
}

async function gmailList(request) {
  return withConnector(request, 'gmail', async (token) => {
    const listed = await readGoogle(await googleFetch(token, 'https://gmail.googleapis.com/gmail/v1/users/me/threads?maxResults=5'));
    if (listed.error) return listed.error;
    const ids = (listed.data.threads || []).map((thread) => thread.id).filter((id) => gmailThreadId(id)).slice(0, 5);
    const threads = [];
    for (const id of ids) {
      const detail = await readGoogle(await googleFetch(
        token,
        `https://gmail.googleapis.com/gmail/v1/users/me/threads/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
      ));
      if (detail.error) return detail.error;
      const headers = headerMap(detail.data.messages?.[0]?.payload?.headers);
      threads.push({
        id,
        subject: headers.subject || '(no subject)',
        from: headers.from || '',
        date: headers.date || '',
        snippet: oneLine(detail.data.snippet, 240),
      });
    }
    return json({ threads });
  });
}

async function gmailRead(request) {
  const { body, error } = await readJson(request);
  if (error) return error;
  const id = gmailThreadId(body?.id);
  if (!id) return json({ error: 'Missing thread id' }, 400);
  return withConnector(request, 'gmail', async (token) => {
    const detail = await readGoogle(await googleFetch(token, `https://gmail.googleapis.com/gmail/v1/users/me/threads/${id}?format=full`));
    if (detail.error) return detail.error;
    const message = detail.data.messages?.[0];
    const headers = headerMap(message?.payload?.headers);
    const text = (detail.data.messages || []).map((item) => gmailPlainText(item.payload)).filter(Boolean).join('\n\n').slice(0, 8000);
    return json({
      id,
      subject: headers.subject || '(no subject)',
      from: headers.from || '',
      date: headers.date || '',
      text,
    });
  });
}

async function gmailDraft(request) {
  const { body, error } = await readJson(request);
  if (error) return error;
  if (body?.send === true) return json({ error: 'Sending mail is not available. Save a draft instead.' }, 400);
  const to = oneLine(body?.to, 254);
  const subject = oneLine(body?.subject, 200);
  const text = String(body?.body ?? '').replace(/\0/g, '').slice(0, 20000);
  if (!validEmail(to)) return json({ error: 'Enter a single recipient email address.' }, 400);
  if (!subject) return json({ error: 'Enter a subject.' }, 400);
  if (!text.trim()) return json({ error: 'Enter a message.' }, 400);
  return withConnector(request, 'gmail', async (token) => {
    const created = await readGoogle(await googleFetch(token, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      body: JSON.stringify({ message: { raw: rfc822({ to, subject, body: text }) } }),
    }));
    if (created.error) return created.error;
    return json({ id: created.data.id || null, sent: false });
  });
}

async function driveList(request) {
  const { body, error } = await readJson(request);
  if (error) return error;
  return withConnector(request, 'drive', async (token) => {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('pageSize', '20');
    url.searchParams.set('q', driveListQuery(body?.query));
    url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,size)');
    url.searchParams.set('orderBy', 'modifiedTime desc');
    const listed = await readGoogle(await googleFetch(token, url));
    if (listed.error) return listed.error;
    const files = (listed.data.files || []).slice(0, 20).map((file) => ({
      id: file.id,
      name: oneLine(file.name, 200),
      mimeType: oneLine(file.mimeType, 120),
      modifiedTime: file.modifiedTime || null,
      size: file.size || null,
    }));
    return json({ files });
  });
}

const EXPORTS = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

function textMime(mime) {
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || mime === 'application/javascript';
}

async function driveRead(request) {
  const { body, error } = await readJson(request);
  if (error) return error;
  const id = driveFileId(body?.id);
  if (!id) return json({ error: 'Missing file id' }, 400);
  return withConnector(request, 'drive', async (token) => {
    const metaRes = await readGoogle(await googleFetch(
      token,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size`,
    ));
    if (metaRes.error) return metaRes.error;
    const meta = metaRes.data;
    const mime = String(meta.mimeType || '');
    const file = { id: meta.id, name: oneLine(meta.name, 200), mimeType: oneLine(mime, 120), text: null };
    const size = Number(meta.size || 0);
    if (EXPORTS[mime]) {
      const exported = await googleFetch(
        token,
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(EXPORTS[mime])}`,
      );
      if (exported.status === 429) return json({ error: 'Google is rate limiting this account. Please retry shortly.' }, 429);
      if (!exported.ok) return json({ error: `Google request failed (${exported.status}). Please retry.` }, 502);
      file.text = await readTextCap(exported, 20000);
    } else if (textMime(mime) && (!size || size <= 200_000)) {
      const media = await googleFetch(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
      if (media.status === 429) return json({ error: 'Google is rate limiting this account. Please retry shortly.' }, 429);
      if (!media.ok) return json({ error: `Google request failed (${media.status}). Please retry.` }, 502);
      file.text = await readTextCap(media, 20000);
    }
    return json({ file });
  });
}

async function calendarList(request) {
  return withConnector(request, 'calendar', async (token) => {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    url.searchParams.set('maxResults', '10');
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('timeMin', new Date().toISOString());
    const listed = await readGoogle(await googleFetch(token, url));
    if (listed.error) return listed.error;
    const events = (listed.data.items || []).slice(0, 10).map((event) => ({
      id: event.id,
      summary: oneLine(event.summary, 200),
      start: event.start?.dateTime || event.start?.date || null,
      end: event.end?.dateTime || event.end?.date || null,
      location: oneLine(event.location, 300),
    }));
    return json({ events });
  });
}

async function calendarCreate(request) {
  const { body, error } = await readJson(request);
  if (error) return error;
  const summary = oneLine(body?.summary, 200);
  const start = parseTime(body?.start);
  const end = parseTime(body?.end);
  if (!summary) return json({ error: 'Enter an event title.' }, 400);
  if (!start || !end || Date.parse(end) <= Date.parse(start)) return json({ error: 'Enter a start and a later end.' }, 400);
  if (Date.parse(end) - Date.parse(start) > 14 * 24 * 60 * 60 * 1000) return json({ error: 'Events are limited to 14 days.' }, 400);
  const event = {
    summary,
    start: { dateTime: start },
    end: { dateTime: end },
  };
  const description = oneLine(body?.description, 4000);
  const location = oneLine(body?.location, 300);
  if (description) event.description = description;
  if (location) event.location = location;
  return withConnector(request, 'calendar', async (token) => {
    const created = await readGoogle(await googleFetch(token, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      body: JSON.stringify(event),
    }));
    if (created.error) return created.error;
    return json({
      id: created.data.id || null,
      summary: oneLine(created.data.summary, 200),
      start: created.data.start?.dateTime || start,
      end: created.data.end?.dateTime || end,
    });
  });
}

const ROUTES = new Map([
  ['GET /api/google/status', status],
  ['GET /api/google/connect', connect],
  ['GET /api/google/callback', callback],
  ['POST /api/google/disconnect', disconnect],
  ['POST /api/google/gmail/list', gmailList],
  ['POST /api/google/gmail/read', gmailRead],
  ['POST /api/google/gmail/draft', gmailDraft],
  ['POST /api/google/drive/list', driveList],
  ['POST /api/google/drive/read', driveRead],
  ['POST /api/google/calendar/list', calendarList],
  ['POST /api/google/calendar/create', calendarCreate],
]);

export async function handle(request) {
  const path = new URL(request.url).pathname.replace(/\/$/, '') || '/';
  const handler = ROUTES.get(`${request.method} ${path}`);
  if (handler) return handler(request);
  if ([...ROUTES.keys()].some((key) => key.endsWith(` ${path}`))) {
    return new Response('Method Not Allowed', { status: 405, headers: { 'cache-control': 'no-store' } });
  }
  return json({ error: 'Not found' }, 404);
}

export const GET = handle;
export const POST = handle;
