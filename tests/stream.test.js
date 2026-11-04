import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { POST, relayStream } = await import('../api/run.js');
const store = await import('../src/store.js');
const runner = await import('../src/runner.js');

const tick = async (predicate) => {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Run did not reach expected state');
};

// Builds a fake fetch Response whose body emits the given SSE chunks.
const sse = (chunks, { error } = {}) => new Response(new ReadableStream({
  start(controller) {
    const enc = new TextEncoder();
    for (const c of chunks) controller.enqueue(enc.encode(c));
    if (error) controller.error(new Error(error));
    else controller.close();
  },
}), { headers: { 'content-type': 'text/event-stream' } });

const ev = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
const delta = (text) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const START = ev({ type: 'message_start', message: { model: 'test-model', usage: { input_tokens: 3 } } });
const STOP = ev({ type: 'message_stop' });

async function events(response) {
  const text = await response.text();
  return text.split('\n\n').filter(Boolean).map(chunk => JSON.parse(chunk.replace(/^data: /, '')));
}

// ---------- server relay ----------
test('relay forwards text and ends with a single done event', async () => {
  const out = await events(relayStream(sse([START, delta('Hello'), delta(' world'), ev({ type: 'message_delta', usage: { output_tokens: 2 } }), STOP])));
  assert.deepEqual(out.filter(e => e.type === 'text').map(e => e.text), ['Hello', ' world']);
  const last = out.at(-1);
  assert.equal(last.type, 'done');
  assert.equal(last.model, 'test-model');
  assert.deepEqual(last.usage, { input_tokens: 3, output_tokens: 2 });
  assert.equal(out.filter(e => e.type === 'done' || e.type === 'error').length, 1);
});

test('relay handles CRLF framing and events split across chunks', async () => {
  const raw = (START + delta('Split') + STOP).replace(/\n/g, '\r\n');
  const out = await events(relayStream(sse([raw.slice(0, 17), raw.slice(17, 90), raw.slice(90)])));
  assert.equal(out.find(e => e.type === 'text').text, 'Split');
  assert.equal(out.at(-1).type, 'done');
});

test('relay reports provider stream errors without leaking details and never sends done', async () => {
  const out = await events(relayStream(sse([START, delta('Part'), ev({ type: 'error', error: { message: 'internal overload id=secret' } })])));
  assert.equal(out.at(-1).type, 'error');
  assert.ok(!out.some(e => e.type === 'done'));
  assert.ok(!JSON.stringify(out).includes('secret'));
});

test('relay treats a stream that ends before message_stop as a failure', async () => {
  const out = await events(relayStream(sse([START, delta('Half an ans')])));
  assert.equal(out.at(-1).type, 'error');
  assert.match(out.at(-1).error, /ended early/);
});

test('relay treats a broken upstream connection as a failure', async () => {
  const out = await events(relayStream(sse([START, delta('Hi')], { error: 'socket reset' })));
  assert.equal(out.at(-1).type, 'error');
  assert.ok(!out.some(e => e.type === 'done'));
});

test('relay treats a stream with no text as a failure', async () => {
  const out = await events(relayStream(sse([START, STOP])));
  assert.equal(out.at(-1).type, 'error');
});

// ---------- server POST with stream=true ----------
const originalFetch = globalThis.fetch;
const originalKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
});

test('POST stream=true asks the provider to stream and relays SSE', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-only';
  let sent;
  globalThis.fetch = async (url, init) => { sent = JSON.parse(init.body); return sse([START, delta('Live'), STOP]); };
  const response = await POST(new Request('http://localhost/api/run', { method: 'POST', body: JSON.stringify({ task: 'Go', stream: true }) }));
  assert.equal(sent.stream, true);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const out = await events(response);
  assert.equal(out.at(-1).type, 'done');
});

test('POST stream=true returns a JSON 502 when the provider rejects the request', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-only';
  globalThis.fetch = async () => new Response('upstream secret detail', { status: 529 });
  const response = await POST(new Request('http://localhost/api/run', { method: 'POST', body: JSON.stringify({ task: 'Go', stream: true }) }));
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('secret'));
});

// ---------- client runner ----------
const clientSse = (events, opts) => sse(events.map(e => `data: ${JSON.stringify(e)}\n\n`), opts);

beforeEach(async () => {
  store.reset();
  globalThis.fetch = async () => Response.json({ live: true });
  await runner.checkLive();
});

test('streamed live output completes the step and stays unverified', async () => {
  globalThis.fetch = async () => clientSse([{ type: 'text', text: 'Streamed ' }, { type: 'text', text: 'draft' }, { type: 'done' }]);
  const { run } = runner.startRun({ task: 'Draft a memo', agentIds: [store.getState().agents[0].id] });
  await tick(() => run.status !== 'running');
  assert.equal(run.status, 'completed');
  assert.equal(run.steps[0].output, 'Streamed draft');
  assert.equal(run.steps[0].mode, 'live');
  assert.equal(run.verified, false);
  assert.equal(store.getState().wallet.sclv, 0);
});

test('a stream error event fails the run', async () => {
  globalThis.fetch = async () => clientSse([{ type: 'text', text: 'Partial' }, { type: 'error', error: 'The model stream failed. Please retry.' }]);
  const { run } = runner.startRun({ task: 'Draft a memo', agentIds: [store.getState().agents[0].id] });
  await tick(() => run.status !== 'running');
  assert.equal(run.status, 'failed');
  assert.match(run.error, /stream failed/);
});

test('a stream without a done event fails the run instead of completing', async () => {
  globalThis.fetch = async () => clientSse([{ type: 'text', text: 'Cut off' }]);
  const { run } = runner.startRun({ task: 'Draft a memo', agentIds: [store.getState().agents[0].id] });
  await tick(() => run.status !== 'running');
  assert.equal(run.status, 'failed');
});

test('stopping a run aborts the request, releases queued credits and blocks later completion', async () => {
  let aborted = false;
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Stopped', 'AbortError')); });
  });
  const ids = store.getState().agents.map(a => a.id);
  const { run } = runner.startRun({ task: 'Write a brief', agentIds: [ids[0], ids[0]] });
  await tick(() => run.steps[0].status === 'running');
  assert.ok(runner.creditUsage().reserved > 0);
  const usedBefore = store.getState().wallet.creditsUsed;

  runner.stopRun(run.id);
  await new Promise(r => setTimeout(r, 50));
  assert.ok(aborted);
  assert.equal(run.status, 'stopped');
  assert.ok(run.steps.every(s => s.status === 'stopped'));
  assert.equal(runner.creditUsage().reserved, 0);
  assert.equal(store.getState().wallet.creditsUsed, usedBefore, 'started step keeps its charge, nothing new is charged');

  runner.approve(run.id);
  runner.stopRun(run.id);
  assert.equal(run.status, 'stopped');
});

test('stop cannot change a finished run', async () => {
  globalThis.fetch = async () => Response.json({ mode: 'live', output: 'Done.' });
  const { run } = runner.startRun({ task: 'Draft', agentIds: [store.getState().agents[0].id] });
  await tick(() => run.status === 'completed');
  runner.stopRun(run.id);
  assert.equal(run.status, 'completed');
});

test('runs orphaned by a page reload are stopped and release reservations', () => {
  const id = store.getState().agents[0].id;
  store.update(s => s.runs.push({ id: 'orphan', status: 'running', current: 0, steps: [{ agentId: id, status: 'running', output: '' }, { agentId: id, status: 'queued', output: '' }] }));
  assert.ok(runner.creditUsage().reserved > 0);
  runner.recoverInterrupted();
  const orphan = store.getState().runs.find(r => r.id === 'orphan');
  assert.equal(orphan.status, 'stopped');
  assert.match(orphan.error, /reload/);
  assert.equal(runner.creditUsage().reserved, 0);
});
