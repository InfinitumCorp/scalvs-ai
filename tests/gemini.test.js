// Gemini is an optional Google AI Studio fallback. It stays off without
// GEMINI_API_KEY, never replaces a healthy Claude or Workers AI response, and
// is what a 429 falls through to.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GET, POST } from '../api/run.js';

const originalFetch = globalThis.fetch;
const KEYS = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_BASE_URL', 'SCALVS_MODEL'];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const request = (body = { task: 'Draft a memo' }) => new Request('http://localhost/api/run', {
  method: 'POST',
  body: JSON.stringify(body),
});

function clearProviders() {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_BASE_URL;
  delete process.env.GEMINI_MODEL;
}

const geminiOk = (text = 'From Gemini', extra = {}) => Response.json({
  modelVersion: 'gemini-2.5-flash',
  candidates: [{ content: { parts: [{ text }, { text: 'hidden', thought: true }] } }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
  ...extra,
});

test('Gemini stays off when GEMINI_API_KEY is unset', async () => {
  clearProviders();
  let called = false;
  globalThis.fetch = async () => { called = true; return geminiOk(); };
  const response = await POST(request(), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).mode, 'demo');
  assert.equal(called, false);
  assert.equal((await (await GET(null, {})).json()).live, false);
});

test('Gemini answers on the AI Studio host when it is the only provider', async () => {
  clearProviders();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  let sent;
  globalThis.fetch = async (url, init) => { sent = { url: String(url), init }; return geminiOk('Draft memo'); };
  const response = await POST(request(), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, 'live');
  assert.equal(body.output, 'Draft memo');
  assert.equal(body.model, 'gemini-2.5-flash');
  assert.deepEqual(body.usage, { input_tokens: 3, output_tokens: 2 });
  const url = new URL(sent.url);
  assert.equal(url.hostname, 'generativelanguage.googleapis.com');
  assert.equal(url.pathname, '/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(url.search, '');
  assert.equal(sent.init.headers['x-goog-api-key'], 'test-gemini-key');
  assert.equal(JSON.stringify(sent).includes('aiplatform.googleapis.com'), false);
  const payload = JSON.parse(sent.init.body);
  assert.equal(payload.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.match(payload.systemInstruction.parts[0].text, /SCALVS\.ai/);
  assert.equal((await (await GET(null, {})).json()).live, true);
});

test('a Gemini 429 is a retryable error and does not leak the upstream body', async () => {
  clearProviders();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'quota for key test-gemini-key exhausted' } }), { status: 429 });
  const response = await POST(request(), {});
  assert.equal(response.status, 429);
  const text = await response.text();
  assert.match(text, /rate limited/i);
  assert.equal(text.includes('test-gemini-key'), false);
  assert.equal(text.includes('exhausted'), false);
});

test('Claude stays primary when Gemini is also configured', async () => {
  clearProviders();
  process.env.ANTHROPIC_API_KEY = 'test-anthropic';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return Response.json({ model: 'claude-test', content: [{ type: 'text', text: 'From Claude' }], usage: null });
  };
  const response = await POST(request(), { AI: { async run() { throw new Error('workers should not run'); } } });
  assert.equal((await response.json()).output, 'From Claude');
  assert.deepEqual(urls.map((url) => new URL(url).hostname), ['api.anthropic.com']);
});

test('Workers AI stays ahead of Gemini', async () => {
  clearProviders();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  let called = false;
  globalThis.fetch = async () => { called = true; return geminiOk(); };
  const response = await POST(request(), { AI: { async run() { return { response: 'From Workers' }; } } });
  assert.equal((await response.json()).output, 'From Workers');
  assert.equal(called, false);
});

test('a Claude 429 falls through to Gemini', async () => {
  clearProviders();
  process.env.ANTHROPIC_API_KEY = 'test-anthropic';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  const hosts = [];
  globalThis.fetch = async (url) => {
    hosts.push(new URL(url).hostname);
    if (hosts.length === 1) return new Response('upstream secret', { status: 429 });
    return geminiOk('Fell back');
  };
  const response = await POST(request(), {});
  assert.equal((await response.json()).output, 'Fell back');
  assert.deepEqual(hosts, ['api.anthropic.com', 'generativelanguage.googleapis.com']);
});

test('a Workers AI 429 falls through to Gemini', async () => {
  clearProviders();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  globalThis.fetch = async () => geminiOk('After workers');
  const err = new Error('429 rate limit');
  err.status = 429;
  const response = await POST(request(), { AI: { async run() { throw err; } } });
  assert.equal((await response.json()).output, 'After workers');
});

test('Gemini streams text and ends with done', async () => {
  clearProviders();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  const chunks = [
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello' }] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: ' there' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } })}\n\n`,
  ];
  globalThis.fetch = async (url) => {
    assert.match(String(url), /streamGenerateContent\?alt=sse$/);
    return new Response(new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const response = await POST(request({ task: 'Hi', stream: true }), {});
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = (await response.text()).trim().split('\n\n').map((line) => JSON.parse(line.slice(5)));
  assert.equal(events.filter((event) => event.type === 'text').map((event) => event.text).join(''), 'Hello there');
  assert.equal(events.at(-1).type, 'done');
});

test('an empty Gemini answer is not a successful run', async () => {
  clearProviders();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  globalThis.fetch = async () => Response.json({ candidates: [{ content: { parts: [{ text: '   ', thought: false }] } }] });
  assert.equal((await POST(request(), {})).status, 502);
});

test('a Vertex base URL is refused and never called', async () => {
  clearProviders();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.GEMINI_BASE_URL = 'https://us-central1-aiplatform.googleapis.com';
  let called = false;
  globalThis.fetch = async () => { called = true; return geminiOk(); };
  const response = await POST(request(), {});
  assert.equal(response.status, 502);
  assert.match(await response.text(), /AI Studio/);
  assert.equal(called, false);
});
