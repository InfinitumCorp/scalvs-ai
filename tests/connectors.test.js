// End-to-end connector tests against a local mock MCP server + OAuth authorization server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

process.env.SCALVS_ALLOW_LOCAL = '1';
const { handle, agentTools } = await import('../api/connectors.js');
const { POST: runPost } = await import('../api/run.js');
const { checkUrl } = await import('../api/_vault.js');

const APP = 'http://localhost:8788';
let base;
let server;
const challenges = new Map();
const calls = [];
const TOOLS = [
  { name: 'search_notes', description: 'Search notes', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, annotations: { readOnlyHint: true } },
  { name: 'create_note', description: 'Create a note', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: false } },
];
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function rpc(req, res, body, { sse = false } = {}) {
  const msg = JSON.parse(body);
  if (!('id' in msg)) { res.writeHead(202).end(); return; }
  let result;
  if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } };
  else if (msg.method === 'tools/list') result = { tools: TOOLS };
  else if (msg.method === 'tools/call') { calls.push(msg.params); result = { content: [{ type: 'text', text: `found: ${msg.params.arguments.q}` }] }; }
  const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
  if (sse && msg.method === 'tools/call') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
    res.end(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: ${reply}\n\n`);
  } else {
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }).end(reply);
  }
}

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url, base);
    const auth = req.headers.authorization || '';
    if (url.pathname === '/mcp' && req.method === 'POST') {
      if (auth !== 'Bearer good-token') {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end();
        return;
      }
      return rpc(req, res, body, { sse: true });
    }
    if (url.pathname === '/open-mcp' && req.method === 'POST') return rpc(req, res, body);
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] }));
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
        token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
      }));
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const reg = JSON.parse(body);
      assert.deepEqual(reg.redirect_uris, [`${APP}/api/oauth/callback`]);
      return res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ client_id: 'cid-123', token_endpoint_auth_method: 'none' }));
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code') {
        const expected = challenges.get(p.get('code'));
        const actual = b64url(createHash('sha256').update(p.get('code_verifier')).digest());
        if (!expected || expected !== actual || p.get('client_id') !== 'cid-123') {
          return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }));
        }
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'good-token', refresh_token: 'r1', expires_in: 3600, token_type: 'Bearer' }));
      }
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

let cookie;
const req = (path, { method = 'GET', body, headers = {} } = {}) => new Request(`${APP}${path}`, {
  method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json', origin: APP } : {}), ...headers },
  body: body ? JSON.stringify(body) : undefined,
});
const call = async (path, opts) => handle(req(path, opts), {});

test('full MCP OAuth flow: discover, register, PKCE, callback, tools, call', async () => {
  const first = await call('/api/connectors');
  cookie = first.headers.get('set-cookie').split(';')[0];
  const list = await first.json();
  assert.ok(list.catalog.some((c) => c.id === 'notion'));
  assert.equal(list.catalog.find((c) => c.id === 'gmail').ready, false); // no Google app configured

  const { custom } = await (await call('/api/connectors/custom', { method: 'POST', body: { name: 'Mock Notes', url: `${base}/mcp` } })).json();
  const started = await (await call(`/api/connectors/${custom.id}/connect`, { method: 'POST', body: {} })).json();
  const auth = new URL(started.redirect);
  assert.equal(auth.origin + auth.pathname, `${base}/authorize`);
  assert.equal(auth.searchParams.get('client_id'), 'cid-123');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('resource'), `${base}/mcp`);

  // the user approves; the server sends them back with a code
  challenges.set('code-1', auth.searchParams.get('code_challenge'));
  const back = await call(`/api/oauth/callback?code=code-1&state=${auth.searchParams.get('state')}`);
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), `${APP}/#/connect?connected=${custom.id}`);

  // a state can only be used once
  const replay = await call(`/api/oauth/callback?code=code-1&state=${auth.searchParams.get('state')}`);
  assert.match(decodeURIComponent(replay.headers.get('location')), /expired/);

  const after = await (await call('/api/connectors')).json();
  const conn = after.connections[custom.id];
  assert.equal(conn.auth, 'oauth');
  assert.deepEqual(conn.tools.map((t) => [t.name, t.enabled]), [['search_notes', true], ['create_note', false]]);
  assert.equal(JSON.stringify(after).includes('good-token'), false, 'tokens never reach the browser');

  const out = await (await call(`/api/connectors/${custom.id}/call`, { method: 'POST', body: { tool: 'search_notes', args: { q: 'budget' } } })).json();
  assert.equal(out.text, 'found: budget'); // answered over an SSE stream

  // agents only get the tools that are switched on
  const { tools } = await agentTools(req('/api/run'), {});
  assert.deepEqual(tools.map((t) => t.label), ['Mock Notes · search_notes']);
  await call(`/api/connectors/${custom.id}/tools/create_note`, { method: 'POST', body: { enabled: true } });
  assert.equal((await agentTools(req('/api/run'), {})).tools.length, 2);
  await call(`/api/connectors/${custom.id}/tools/create_note`, { method: 'POST', body: { enabled: false } });
});

test('agent runs call connected tools (Workers AI function calling)', async () => {
  let round = 0;
  const env = { AI: { async run(_model, input) {
    round += 1;
    if (round === 1) {
      assert.ok(input.tools.some((t) => t.function.name.endsWith('search_notes')));
      return { tool_calls: [{ name: input.tools[0].function.name, arguments: { q: 'Q3 plan' } }] };
    }
    assert.equal(input.messages.at(-1).content, 'found: Q3 plan');
    return { response: 'The Q3 plan note exists.' };
  } } };
  const res = await runPost(new Request(`${APP}/api/run`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ task: 'Find the Q3 plan', agent: { name: 'Atlas' } }) }), env);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.match(body.output, /^\*Used Mock Notes · search_notes\*/);
  assert.match(body.output, /The Q3 plan note exists/);
});

test('open servers connect without sign-in; others fall back to a token', async () => {
  const open = (await (await call('/api/connectors/custom', { method: 'POST', body: { name: 'Open', url: `${base}/open-mcp` } })).json()).custom;
  const r = await (await call(`/api/connectors/${open.id}/connect`, { method: 'POST', body: {} })).json();
  assert.equal(r.connection.auth, 'none');

  // an API-key server on its own origin, with no OAuth metadata anywhere
  const keyedServer = createServer(async (rq, rs) => {
    const chunks = [];
    for await (const c of rq) chunks.push(c);
    if (rq.url !== '/keyed-mcp' || rq.method !== 'POST') return rs.writeHead(404).end();
    if (rq.headers.authorization !== 'Bearer my-api-key') return rs.writeHead(401).end();
    rpc(rq, rs, Buffer.concat(chunks).toString());
  });
  await new Promise((r) => keyedServer.listen(0, '127.0.0.1', r));
  const keyedBase = `http://127.0.0.1:${keyedServer.address().port}`;
  const keyed = (await (await call('/api/connectors/custom', { method: 'POST', body: { name: 'Keyed', url: `${keyedBase}/keyed-mcp` } })).json()).custom;
  const ask = await (await call(`/api/connectors/${keyed.id}/connect`, { method: 'POST', body: {} })).json();
  assert.equal(ask.needsToken, true);
  const bad = await call(`/api/connectors/${keyed.id}/connect`, { method: 'POST', body: { token: 'wrong' } });
  assert.equal(bad.status, 400);
  const good = await (await call(`/api/connectors/${keyed.id}/connect`, { method: 'POST', body: { token: 'my-api-key' } })).json();
  assert.equal(good.connection.auth, 'token');

  await call(`/api/connectors/${keyed.id}/disconnect`, { method: 'POST', body: {} });
  assert.equal((await (await call('/api/connectors')).json()).connections[keyed.id], undefined);
  keyedServer.close();
});

test('native apps explain missing OAuth setup', async () => {
  const r = await call('/api/connectors/gmail/connect', { method: 'POST', body: {} });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /GOOGLE_CLIENT_ID/);
});

test('cross-site requests and other browsers are refused', async () => {
  const r = await call('/api/connectors/custom', { method: 'POST', body: { name: 'x', url: 'https://example.com/mcp' }, headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  const other = await handle(new Request(`${APP}/api/oauth/callback?code=x&state=nope`), {});
  assert.match(decodeURIComponent(other.headers.get('location')), /expired/);
});

test('connector URLs must be public https', () => {
  delete process.env.SCALVS_ALLOW_LOCAL;
  for (const bad of ['http://example.com/mcp', 'https://10.0.0.5/mcp', 'https://192.168.1.2/mcp', 'https://localhost/mcp', 'https://[::1]/mcp', 'https://user:pw@example.com/mcp', 'not a url']) {
    assert.throws(() => checkUrl(bad, {}), undefined, bad);
  }
  assert.equal(checkUrl('https://mcp.notion.com/mcp', {}).hostname, 'mcp.notion.com');
  process.env.SCALVS_ALLOW_LOCAL = '1';
});
