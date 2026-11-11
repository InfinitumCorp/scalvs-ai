// OpenClaw (MIT, open source) as SCALVS.ai's primary agent engine: when
// OPENCLAW_URL is set, every agent step goes to the OpenClaw gateway's
// OpenAI-compatible endpoint, ahead of Claude, Workers AI and plain open weights.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { POST, GET } from '../api/run.js';
import {
  DEFAULT_OPENCLAW_AGENT,
  hasOpenClaw,
  hasOpenWeights,
  openWeightsHeaders,
  openWeightsModel,
  openWeightsUrls,
} from '../api/_open-weights.js';

const VARS = ['OPENCLAW_URL', 'OPENCLAW_TOKEN', 'OPENCLAW_AGENT', 'OPENCLAW_MODEL', 'OPEN_WEIGHTS_URL', 'OPEN_WEIGHTS_MODEL', 'ANTHROPIC_API_KEY'];
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of VARS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

const runRequest = (extra = {}) => new Request('https://scalvs.test/api/run', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ agent: { name: 'A', role: 'Writer' }, task: 'write a memo', stream: false, ...extra }),
});

test('OpenClaw is off until OPENCLAW_URL is set', () => {
  for (const k of VARS) delete process.env[k];
  assert.equal(hasOpenClaw(), false);
  process.env.OPENCLAW_URL = 'http://claw:18789/v1';
  assert.equal(hasOpenClaw(), true);
  assert.equal(hasOpenWeights(), true);
  assert.deepEqual(openWeightsUrls(), ['http://claw:18789/v1']);
  assert.equal(openWeightsModel(), DEFAULT_OPENCLAW_AGENT);
});

test('the gateway token and model override travel as headers; OPEN_WEIGHTS_* is ignored', () => {
  for (const k of VARS) delete process.env[k];
  process.env.OPENCLAW_URL = 'http://claw:18789/v1';
  process.env.OPENCLAW_TOKEN = 'tok';
  process.env.OPENCLAW_AGENT = 'openclaw/research';
  process.env.OPENCLAW_MODEL = 'ollama/qwen3:8b';
  process.env.OPEN_WEIGHTS_URL = 'http://other:11434/v1';
  process.env.OPEN_WEIGHTS_MODEL = 'llama';
  assert.deepEqual(openWeightsUrls(), ['http://claw:18789/v1']);
  assert.equal(openWeightsModel(), 'openclaw/research');
  assert.deepEqual(openWeightsHeaders(), {
    'content-type': 'application/json',
    authorization: 'Bearer tok',
    'x-openclaw-model': 'ollama/qwen3:8b',
  });
});

test('/api/run sends the agent step to OpenClaw even when a Claude key is set', async () => {
  for (const k of VARS) delete process.env[k];
  process.env.OPENCLAW_URL = 'http://claw:18789/v1';
  process.env.OPENCLAW_TOKEN = 'tok';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return Response.json({ choices: [{ message: { content: 'Memo from OpenClaw' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
  };
  const res = await POST(runRequest());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'live');
  assert.equal(body.model, DEFAULT_OPENCLAW_AGENT);
  assert.equal(body.output, 'Memo from OpenClaw');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://claw:18789/v1/chat/completions');
  assert.equal(seen[0].headers.authorization, 'Bearer tok');
  assert.equal(seen[0].body.model, DEFAULT_OPENCLAW_AGENT);
  assert.equal(seen[0].body.messages[0].role, 'system');
});

test('a streamed step from OpenClaw is an SSE Response the Worker can forward', async () => {
  for (const k of VARS) delete process.env[k];
  process.env.OPENCLAW_URL = 'http://claw:18789/v1';
  let sent;
  globalThis.fetch = async (_u, init) => {
    sent = JSON.parse(init.body);
    const enc = new TextEncoder();
    return new Response(new ReadableStream({
      start(c) {
        for (const s of ['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', 'data: [DONE]\n\n']) c.enqueue(enc.encode(s));
        c.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const res = await POST(runRequest({ stream: true }));
  assert.ok(res instanceof Response);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.equal(sent.stream, true);
  const events = (await res.text()).trim().split('\n\n').map((l) => JSON.parse(l.slice(5)));
  assert.deepEqual(events.map((e) => e.type), ['text', 'done']);
});

test('think mode also runs on OpenClaw', async () => {
  for (const k of VARS) delete process.env[k];
  process.env.OPENCLAW_URL = 'http://claw:18789/v1';
  let url;
  globalThis.fetch = async (u) => {
    url = String(u);
    return Response.json({ choices: [{ message: { content: 'Thought-through answer' } }] });
  };
  const res = await POST(runRequest({ mode: 'think' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.output, 'Thought-through answer');
  assert.equal(url, 'http://claw:18789/v1/chat/completions');
});

test('GET /api/run reports live with engine "openclaw"', async () => {
  for (const k of VARS) delete process.env[k];
  process.env.OPENCLAW_URL = 'http://claw:18789/v1';
  const body = await (await GET(new Request('https://scalvs.test/api/run'), {})).json();
  assert.equal(body.live, true);
  assert.equal(body.engine, 'openclaw');
});
