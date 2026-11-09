// Connectors API (Worker routes /api/connectors/* and /api/oauth/callback).
//
//   GET    /api/connectors                          catalog, your connections, custom connectors
//   POST   /api/connectors/custom                   {name, url}            add a custom MCP connector
//   DELETE /api/connectors/custom/:id                                     remove it (and its tokens)
//   POST   /api/connectors/:id/connect              {token?}               connect; OAuth answers {redirect}
//   POST   /api/connectors/:id/disconnect                                 forget tokens
//   POST   /api/connectors/:id/refresh                                    re-read the tool list
//   POST   /api/connectors/:id/tools/:tool          {enabled}              allow/deny a tool for agents
//   POST   /api/connectors/:id/call                 {tool, args}           run a tool yourself (test)
//   GET    /api/oauth/callback?code&state                                 OAuth redirect target
//
// Tokens never reach the browser. See api/_vault.js for storage and api/_oauth.js for sign-in.
import { CATALOG, findConnector, isReadOnlyTool } from '../src/connectors.js';
import { cfg, checkUrl, loadRecord, putPending, randomId, readSession, saveRecord, sessionCookie, takePending } from './_vault.js';
import { AuthRequired, callTool, listTools } from './_mcp.js';
import { authorizeUrl, discover, exchangeCode, expiresSoon, pkce, refreshTokens, register, tokenSet } from './_oauth.js';
import { APPS, PROVIDER_APP, nativeTools, runNativeTool } from './_native.js';

const MAX_CUSTOM = 20;
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
});
const errText = (e) => String(e?.message || e || 'Something went wrong').slice(0, 300);

// ---------- helpers ----------
const entryFor = (record, id) => {
  const c = findConnector(id);
  if (c) return c;
  const custom = record.custom.find((x) => x.id === id);
  return custom ? { ...custom, kind: 'mcp', group: 'Custom', token: true, desc: custom.url } : null;
};
const appFor = (entry) => (entry.kind === 'native' ? PROVIDER_APP[entry.provider] : entry.app) || null;
const appClient = (env, app) => {
  const id = cfg(env, `${app}_CLIENT_ID`);
  return id ? { client_id: id, client_secret: cfg(env, `${app}_CLIENT_SECRET`) || null, auth_method: APPS[app].auth_method } : null;
};
const redirectUriFor = (request) => `${new URL(request.url).origin}/api/oauth/callback`;
const scopeFromChallenge = (www) => (String(www || '').match(/scope="([^"]+)"/) || [])[1];
const allowed = (conn, tool) => (tool.name in (conn.perms || {}) ? conn.perms[tool.name] : isReadOnlyTool(tool));

function publicConnection(conn) {
  return {
    id: conn.id, name: conn.name, auth: conn.auth, connectedAt: conn.connectedAt, error: conn.error || null,
    tools: (conn.tools || []).map((t) => ({ name: t.name, description: t.description, readOnly: isReadOnlyTool(t), enabled: allowed(conn, t), inputSchema: t.inputSchema })),
  };
}

async function fetchTools(entry, conn) {
  if (entry.kind === 'native') return nativeTools(entry);
  return listTools(entry.url, conn.tokens?.access_token ? { authorization: `Bearer ${conn.tokens.access_token}` } : {});
}

// Run fn(conn) with a fresh token, refreshing once on expiry or a 401. Mutates conn.
async function withToken(env, entry, conn, fn) {
  const refresh = async () => {
    if (conn.auth !== 'oauth') throw new Error('The token was rejected. Reconnect with a new token.');
    const app = conn.app ? APPS[conn.app] : null;
    const client = conn.app ? appClient(env, conn.app) : conn.client;
    if (!client) throw new Error('This connector is no longer configured on the server.');
    conn.tokens = await refreshTokens({ endpoint: app ? app.token : conn.oauth.token_endpoint, client, tokens: conn.tokens, resource: conn.oauth?.resource }, env);
  };
  try {
    if (conn.auth === 'oauth' && expiresSoon(conn.tokens)) await refresh();
    return await fn(conn);
  } catch (e) {
    if (!(e instanceof AuthRequired || e.auth)) throw e;
    try { await refresh(); } catch (r) { conn.error = 'Sign-in expired. Reconnect.'; throw r; }
    return fn(conn);
  }
}

async function saveConnection(env, sid, record, entry, conn) {
  conn.tools = await fetchTools(entry, conn);
  conn.connectedAt = Date.now();
  conn.error = null;
  conn.perms = record.connections[entry.id]?.perms || {};
  record.connections[entry.id] = conn;
  await saveRecord(env, sid, record);
  return publicConnection(conn);
}

// ---------- connect ----------
async function startOAuth(env, request, sid, entry, { endpoint, tokenEndpoint, client, scope, resource, app, extra, scopeParam }) {
  const state = randomId(24);
  const { verifier, challenge } = await pkce();
  const redirectUri = redirectUriFor(request);
  await putPending(env, state, { sid, id: entry.id, verifier, redirectUri, client: app ? null : client, app, tokenEndpoint, resource });
  const scopeKey = scopeParam || 'scope';
  const url = authorizeUrl({ endpoint, clientId: client.client_id, redirectUri, state, challenge, resource,
    scope: scopeKey === 'scope' ? scope : undefined, extra: { ...extra, ...(scopeKey !== 'scope' && scope ? { [scopeKey]: scope } : {}) } });
  return { redirect: url };
}

async function connect(env, request, sid, record, entry, body) {
  if (entry.kind === 'builtin') return json({ error: 'Built-in products are switched on in the app.' }, 400);
  const app = appFor(entry);

  if (entry.kind === 'native') {
    const client = appClient(env, app);
    if (!client) return json({ error: `${entry.name} sign-in is not set up yet. Add ${app}_CLIENT_ID and ${app}_CLIENT_SECRET to the Worker (${APPS[app].console}).`, setup: true }, 400);
    const a = APPS[app];
    return json(await startOAuth(env, request, sid, entry, { endpoint: a.authorize, tokenEndpoint: a.token, client, app, scope: a.scopes[entry.service], extra: a.extra, scopeParam: a.scopeParam }));
  }

  // Remote MCP server
  checkUrl(entry.url, env);
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (token) {
    if (token.length > 4000) return json({ error: 'That token is too long.' }, 400);
    try {
      return json({ connection: await saveConnection(env, sid, record, entry, { id: entry.id, name: entry.name, auth: 'token', tokens: { access_token: token } }) });
    } catch (e) {
      return json({ error: e instanceof AuthRequired ? 'The server rejected that token.' : errText(e) }, 400);
    }
  }

  let challenge;
  try {
    // Open servers need no sign-in at all.
    return json({ connection: await saveConnection(env, sid, record, entry, { id: entry.id, name: entry.name, auth: 'none' }) });
  } catch (e) {
    if (!(e instanceof AuthRequired)) return json({ error: `Could not reach ${entry.name}: ${errText(e)}` }, 502);
    challenge = e.wwwAuthenticate;
  }

  const client = app ? appClient(env, app) : null;
  if (client) {
    const a = APPS[app];
    return json(await startOAuth(env, request, sid, entry, { endpoint: a.authorize, tokenEndpoint: a.token, client, app, scope: a.scopes[entry.id] || undefined, extra: a.extra }));
  }

  const meta = await discover(entry.url, challenge, env).catch(() => null);
  if (meta?.registration_endpoint) {
    let registered;
    try { registered = await register(meta, redirectUriFor(request), env); } catch (e) {
      if (entry.token) return json({ needsToken: true, help: entry.tokenHelp || 'This server needs an access token.' });
      return json({ error: errText(e) }, 502);
    }
    const scope = scopeFromChallenge(challenge) || (meta.scopes.length ? meta.scopes.join(' ') : undefined);
    return json(await startOAuth(env, request, sid, entry, { endpoint: meta.authorization_endpoint, tokenEndpoint: meta.token_endpoint, client: registered, scope, resource: meta.resource }));
  }
  if (entry.token || entry.group === 'Custom') {
    return json({ needsToken: true, help: entry.tokenHelp || 'This server does not offer automatic sign-in. Paste an access token or API key for it.' });
  }
  if (app) return json({ error: `${entry.name} sign-in is not set up yet. Add ${app}_CLIENT_ID and ${app}_CLIENT_SECRET to the Worker (${APPS[app].console}).`, setup: true }, 400);
  return json({ error: `${entry.name} does not allow automatic app registration. Ask the vendor for an OAuth app, or add it as a custom connector with a token.` }, 502);
}

async function callback(env, request) {
  const url = new URL(request.url);
  const back = (q) => Response.redirect(`${url.origin}/#/connect?${new URLSearchParams(q)}`, 302);
  const state = url.searchParams.get('state');
  const pending = state ? await takePending(env, state) : null;
  if (!pending) return back({ connect_error: 'That sign-in link expired. Try again.' });
  const sid = readSession(request);
  if (!sid || sid !== pending.sid) return back({ connect_error: 'Sign-in was started in another browser. Try again here.' });
  const record = await loadRecord(env, sid);
  const entry = entryFor(record, pending.id);
  if (!entry) return back({ connect_error: 'That connector no longer exists.' });
  if (url.searchParams.get('error')) return back({ connect_error: `${entry.name}: ${url.searchParams.get('error_description') || url.searchParams.get('error')}` });

  try {
    const client = pending.app ? appClient(env, pending.app) : pending.client;
    let data = await exchangeCode({ endpoint: pending.tokenEndpoint, client, code: url.searchParams.get('code'), verifier: pending.verifier, redirectUri: pending.redirectUri, resource: pending.resource }, env);
    if (pending.app && APPS[pending.app].readToken) data = APPS[pending.app].readToken(data);
    if (!data.access_token) throw new Error('No access token was returned');
    await saveConnection(env, sid, record, entry, {
      id: entry.id, name: entry.name, auth: 'oauth', app: pending.app || null, client: pending.app ? null : pending.client,
      oauth: { token_endpoint: pending.tokenEndpoint, resource: pending.resource || null }, tokens: tokenSet(data),
    });
    return back({ connected: entry.id });
  } catch (e) {
    return back({ connect_error: `${entry.name}: ${errText(e)}` });
  }
}

// ---------- router ----------
export async function handle(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/api/oauth/callback' && request.method === 'GET') return callback(env, request);

  // State-changing calls must come from this site (cookie-bound, CSRF-safe).
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return json({ error: 'Cross-site request refused' }, 403);
    if (!origin && request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'Cross-site request refused' }, 403);
  }

  let sid = readSession(request);
  const setCookie = {};
  if (!sid) { sid = randomId(32); setCookie['set-cookie'] = sessionCookie(sid, request); }
  const withCookie = (res) => { if (setCookie['set-cookie']) res.headers.append('set-cookie', setCookie['set-cookie']); return res; };

  const parts = url.pathname.replace(/\/$/, '').split('/').slice(3).map(decodeURIComponent); // after /api/connectors
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

  try {
    const record = await loadRecord(env, sid);

    if (!parts.length && request.method === 'GET') {
      return withCookie(json({
        catalog: CATALOG.map((c) => ({ ...c, ready: c.kind === 'native' || c.appOnly ? Boolean(appClient(env, appFor(c))) : true })),
        custom: record.custom,
        connections: Object.fromEntries(Object.values(record.connections).map((c) => [c.id, publicConnection(c)])),
      }));
    }

    if (parts[0] === 'custom') {
      if (request.method === 'POST' && parts.length === 1) {
        const name = String(body.name || '').trim().slice(0, 40);
        if (!name) return json({ error: 'Give the connector a name.' }, 400);
        const target = checkUrl(String(body.url || '').trim(), env);
        if (record.custom.length >= MAX_CUSTOM) return json({ error: `Up to ${MAX_CUSTOM} custom connectors.` }, 400);
        const custom = { id: `c_${randomId(6)}`, name, url: target.toString() };
        record.custom.push(custom);
        await saveRecord(env, sid, record);
        return withCookie(json({ custom }, 201));
      }
      if (request.method === 'DELETE' && parts[1]) {
        record.custom = record.custom.filter((c) => c.id !== parts[1]);
        delete record.connections[parts[1]];
        await saveRecord(env, sid, record);
        return json({ ok: true });
      }
    }

    const entry = parts[0] ? entryFor(record, parts[0]) : null;
    if (!entry) return json({ error: 'No such connector' }, 404);
    const action = parts[1];
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    if (action === 'connect') return withCookie(await connect(env, request, sid, record, entry, body));

    const conn = record.connections[entry.id];
    if (action === 'disconnect') {
      delete record.connections[entry.id];
      await saveRecord(env, sid, record);
      return json({ ok: true });
    }
    if (!conn) return json({ error: `${entry.name} is not connected.` }, 409);

    if (action === 'refresh') {
      try {
        conn.tools = await withToken(env, entry, conn, (c) => fetchTools(entry, c));
        conn.error = null;
      } finally { await saveRecord(env, sid, record); }
      return json({ connection: publicConnection(conn) });
    }
    if (action === 'tools' && parts[2]) {
      if (!conn.tools.some((t) => t.name === parts[2])) return json({ error: 'No such tool' }, 404);
      conn.perms = { ...(conn.perms || {}), [parts[2]]: Boolean(body.enabled) };
      await saveRecord(env, sid, record);
      return json({ connection: publicConnection(conn) });
    }
    if (action === 'call') {
      const tool = conn.tools.find((t) => t.name === body.tool);
      if (!tool) return json({ error: 'No such tool' }, 404);
      const args = body.args && typeof body.args === 'object' ? body.args : {};
      try {
        const out = await withToken(env, entry, conn, (c) => runTool(entry, c, tool.name, args));
        return json({ ...out, text: out.text.slice(0, 20000) });
      } finally { await saveRecord(env, sid, record); }
    }
    return json({ error: 'Unknown action' }, 404);
  } catch (e) {
    return withCookie(json({ error: errText(e) }, 400));
  }
}

function runTool(entry, conn, name, args) {
  if (entry.kind === 'native') return runNativeTool(entry, conn.tokens.access_token, name, args);
  return callTool(entry.url, conn.tokens?.access_token ? { authorization: `Bearer ${conn.tokens.access_token}` } : {}, name, args);
}

// ---------- for agent runs (api/run.js) ----------
// The tools this visitor allowed for agents, ready to hand to a model.
// Returns { tools: [{name, description, inputSchema, label, run(args)}], save() }.
export async function agentTools(request, env, limit = 40) {
  const sid = readSession(request);
  if (!sid) return { tools: [], save: async () => {} };
  const record = await loadRecord(env, sid);
  let dirty = false;
  const tools = [];
  for (const conn of Object.values(record.connections)) {
    const entry = entryFor(record, conn.id);
    if (!entry || conn.error) continue;
    for (const t of conn.tools || []) {
      if (!allowed(conn, t) || tools.length >= limit) continue;
      const safe = `${conn.id}_${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      tools.push({
        name: safe, label: `${entry.name} · ${t.name}`,
        description: `[${entry.name}] ${t.description || t.name}`.slice(0, 1000),
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
        async run(args) {
          dirty = true;
          const out = await withToken(env, entry, conn, (c) => runTool(entry, c, t.name, args));
          return (out.isError ? `Error: ${out.text}` : out.text).slice(0, 8000) || '(no output)';
        },
      });
    }
  }
  return { tools, save: async () => { if (dirty) await saveRecord(env, sid, record); } };
}
