// Minimal MCP client over Streamable HTTP (spec 2025-06-18), enough for connectors:
// initialize -> notifications/initialized -> tools/list | tools/call.
// Each operation opens a fresh MCP session, so it fits short Worker requests.
// Replies may be plain JSON or an SSE stream; both are handled.

const PROTOCOL = '2025-06-18';
const TIMEOUT_MS = 25000;

export class AuthRequired extends Error {
  constructor(wwwAuthenticate) { super('Sign-in required'); this.wwwAuthenticate = wwwAuthenticate || ''; }
}

async function readSseFor(res, id) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let msg;
        try { msg = JSON.parse(data); } catch { continue; }
        if (msg.id === id && ('result' in msg || 'error' in msg)) return msg;
      }
    }
  } finally { reader.cancel().catch(() => {}); }
  throw new Error('The connector closed the stream without answering');
}

export function mcpSession(url, headers = {}, { fetchImpl = fetch } = {}) {
  let sessionId = null;
  let negotiated = null;
  let nextId = 1;

  async function post(message) {
    const h = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    };
    if (sessionId) h['mcp-session-id'] = sessionId;
    if (negotiated) h['mcp-protocol-version'] = negotiated;
    const res = await fetchImpl(url, { method: 'POST', headers: h, body: JSON.stringify(message), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
    if (res.status === 401 || res.status === 403) {
      const www = res.headers.get('www-authenticate');
      res.body?.cancel().catch(() => {});
      // 403 without credentials also means "sign in" (GitHub answers that way)
      if (res.status === 401 || !h.authorization || /invalid_token|insufficient_scope/.test(www || '')) throw new AuthRequired(www);
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    return res;
  }

  async function request(method, params) {
    const id = nextId++;
    const res = await post({ jsonrpc: '2.0', id, method, params });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Connector answered ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    }
    const type = res.headers.get('content-type') || '';
    const msg = type.includes('text/event-stream') ? await readSseFor(res, id) : await res.json();
    if (msg.error) throw new Error(`Connector error: ${msg.error.message || JSON.stringify(msg.error).slice(0, 160)}`);
    return msg.result;
  }

  async function notify(method, params) {
    const res = await post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    res.body?.cancel().catch(() => {});
  }

  return {
    async initialize() {
      const result = await request('initialize', {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'SCALVS.ai', version: '1.0.0' },
      });
      negotiated = result?.protocolVersion || PROTOCOL;
      await notify('notifications/initialized');
      return result;
    },
    request,
  };
}

export async function listTools(url, headers, opts) {
  const s = mcpSession(url, headers, opts);
  await s.initialize();
  const tools = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const r = await s.request('tools/list', cursor ? { cursor } : {});
    tools.push(...(r?.tools || []));
    cursor = r?.nextCursor;
    if (!cursor) break;
  }
  return tools.map((t) => ({
    name: String(t.name),
    description: String(t.description || '').slice(0, 1000),
    inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
    annotations: t.annotations || {},
  }));
}

export async function callTool(url, headers, name, args, opts) {
  const s = mcpSession(url, headers, opts);
  await s.initialize();
  const r = await s.request('tools/call', { name, arguments: args || {} });
  return { text: toolText(r), isError: Boolean(r?.isError) };
}

// Text of a tools/call result: text blocks, structured content, resource text; images noted.
export function toolText(result) {
  const parts = [];
  for (const block of result?.content || []) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'resource' && block.resource?.text) parts.push(block.resource.text);
    else if (block.type === 'resource_link') parts.push(`[${block.name || 'resource'}] ${block.uri}`);
    else if (block.type === 'image') parts.push('[image]');
  }
  if (!parts.length && result?.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  return parts.join('\n').trim();
}
