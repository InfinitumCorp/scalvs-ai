// Keyless open-weight backend: the operator's OpenAI-compatible server as the
// third tier behind ANTHROPIC_API_KEY and the Workers AI binding.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { POST, GET } from '../api/run.js';
import {
  DEFAULT_OPEN_WEIGHTS_MODEL,
  hasOpenWeights,
  openWeightsBody,
  openWeightsHeaders,
  openWeightsModel,
  openWeightsResultText,
  relayOpenWeightsStream,
  stripThink,
} from '../api/_open-weights.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

async function relayEvents(chunks) {
  const stream = new ReadableStream({ start(c) {
    for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
    c.close();
  } });
  const text = await new Response(relayOpenWeightsStream(stream, 'test')).text();
  return text.trim().split('\n\n').map(line => JSON.parse(line.slice(5)));
}
const delta = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

test('streamed reasoning tags are hidden across every delimiter split and spaces survive', async () => {
  const content = '<think>private reasoning</think>Hello world!';
  for (let split = 1; split < content.length; split++) {
    const events = await relayEvents([delta(content.slice(0, split)), delta(content.slice(split)), 'data: [DONE]\n\n']);
    assert.equal(events.filter(e => e.type === 'text').map(e => e.text).join(''), 'Hello world!');
    assert.equal(events.at(-1).type, 'done');
  }
  const events = await relayEvents([delta('Hello'), delta(' '), delta('world'), 'data: [DONE]\n\n']);
  assert.equal(events.filter(e => e.type === 'text').map(e => e.text).join(''), 'Hello world');
});

test('empty, malformed, upstream-error and truncated streams never report success', async () => {
  for (const chunks of [
    ['data: [DONE]\n\n'],
    [delta('partial')],
    [delta('partial'), 'data: broken\n\n', 'data: [DONE]\n\n'],
    [delta('partial'), 'data: {"error":{"message":"secret"}}\n\n', 'data: [DONE]\n\n'],
    [delta('<think>only reasoning</think>'), 'data: [DONE]\n\n'],
  ]) {
    const events = await relayEvents(chunks);
    assert.equal(events.at(-1).type, 'error');
    assert.equal(events.some(e => e.type === 'done'), false);
    assert.ok(events.at(-1).error);
  }
});

test('network splits preserve CRLF, UTF-8 and usage accounting', async () => {
  const payload = delta('你好 world').replaceAll('\n', '\r\n') + 'data: {"usage":{"total_tokens":3}}\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(payload);
  const stream = new ReadableStream({ start(c) {
    for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
    c.close();
  } });
  const text = await new Response(relayOpenWeightsStream(stream, 'test')).text();
  const events = text.trim().split('\n\n').map(line => JSON.parse(line.slice(5)));
  assert.equal(events[0].text, '你好 world');
  assert.deepEqual(events.at(-1).usage, { total_tokens: 3 });
});

test('client cancellation cancels the locked upstream reader', async () => {
  let cancelled = false;
  const upstream = new ReadableStream({ cancel() { cancelled = true; } });
  const reader = relayOpenWeightsStream(upstream, 'test').getReader();
  await reader.cancel();
  assert.equal(cancelled, true);
});

test('/api/run returns a streaming HTTP Response for the local model', async () => {
  process.env.OPEN_WEIGHTS_URL = 'http://m:11434/v1';
  globalThis.fetch = async () => new Response(delta('Hello world') + 'data: [DONE]\n\n');
  const response = await POST(new Request('https://scalvs.test/api/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: { name: 'A', role: 'Writer' }, task: 'write', stream: true }),
  }));
  assert.ok(response instanceof Response);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.match(await response.text(), /Hello world/);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ['OPEN_WEIGHTS_URL', 'OPEN_WEIGHTS_MODEL', 'OPEN_WEIGHTS_KEY', 'ANTHROPIC_API_KEY']) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

test('hasOpenWeights is off until a URL or model is set, and needs no key', () => {
  assert.equal(hasOpenWeights(), false);
  process.env.OPEN_WEIGHTS_MODEL = 'qwen3:8b';
  assert.equal(hasOpenWeights(), true);
  delete process.env.OPEN_WEIGHTS_MODEL;
  process.env.OPEN_WEIGHTS_URL = 'http://localhost:11434/v1';
  assert.equal(hasOpenWeights(), true);
  assert.equal(openWeightsModel(), DEFAULT_OPEN_WEIGHTS_MODEL);
  assert.deepEqual(openWeightsHeaders(), { 'content-type': 'application/json' });
});

test('result text is read from OpenAI-style choices and <think> is stripped', () => {
  assert.equal(openWeightsResultText({ choices: [{ message: { content: 'hello' } }] }), 'hello');
  assert.equal(openWeightsResultText({ choices: [{ message: { content: '<think>x</think>hi' } }] }), 'hi');
  assert.equal(stripThink('<think>a</think>b'), 'b');
});

test('the request body carries the model, cap and messages', () => {
  const body = openWeightsBody('m1', [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], { maxTokens: 500 });
  assert.deepEqual(body, { model: 'm1', max_tokens: 500, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] });
});

test('an OpenAI SSE stream is re-emitted in the client\'s minimal format', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const stream = new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      for (const t of chunks) c.enqueue(enc.encode(t));
      c.close();
    },
  });
  const out = relayOpenWeightsStream(stream, 'm1');
  const text = await new Response(out).text();
  const events = text.trim().split('\n\n').map((l) => JSON.parse(l.slice(5)));
  assert.deepEqual(events.map((e) => e.type), ['text', 'text', 'done']);
  assert.equal(events.map((e) => e.text).join(''), 'Hello');
  assert.equal(events[2].model, 'm1');
});

test('/api/run answers live from the open-weight server with no key and no AI binding', async () => {
  process.env.OPEN_WEIGHTS_URL = 'http://m:11434/v1';
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, body: JSON.parse(init.body) };
    return Response.json({ model: 'qwen3:8b', choices: [{ message: { content: 'Draft memo' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
  };
  const request = () => new Request('https://scalvs.test/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: { name: 'A', role: 'Writer' }, task: 'write a memo', stream: false }),
  });
  const res = await POST(request());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'live');
  assert.equal(body.model, 'qwen3:8b');
  assert.equal(body.output, 'Draft memo');
  assert.match(seen.url, /\/chat\/completions$/);
  assert.deepEqual(seen.body.messages[0], { role: 'system', content: seen.body.messages[0].content });
});

test('GET /api/run reports live when only the open-weight server is configured', async () => {
  process.env.OPEN_WEIGHTS_URL = 'http://m:11434/v1';
  const res = await GET(new Request('https://scalvs.test/api/run'), {});
  const body = await res.json();
  assert.equal(body.live, true);
});
