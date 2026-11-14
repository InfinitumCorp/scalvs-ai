// Model-server resilience: retry/backoff, failover, circuit breaker, secret redaction.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, EndpointPool, parseRetryAfter, parseUrls, redactMessages, redactSecrets, retryDelayMs } from '../api/_resilience.js';
import { openWeightsFetch, openWeightsUrls } from '../api/_open-weights.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ['OPEN_WEIGHTS_URL', 'OPEN_WEIGHTS_RETRIES', 'OPEN_WEIGHTS_REDACT']) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

const res = (status, headers = {}) => new Response('{}', { status, headers });
const noSleep = { sleep: async () => {} };

test('Retry-After parses seconds and dates, and bad values are ignored', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter('Wed, 11 Nov 2026 12:00:10 GMT', Date.parse('Wed, 11 Nov 2026 12:00:00 GMT')), 10000);
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(parseRetryAfter(null), null);
});

test('backoff grows, is jittered within half the ceiling, and Retry-After wins but is capped', () => {
  const lo = (a) => retryDelayMs(a, { baseMs: 100, maxMs: 1000, random: () => 0 });
  const hi = (a) => retryDelayMs(a, { baseMs: 100, maxMs: 1000, random: () => 1 });
  assert.deepEqual([lo(0), hi(0)], [50, 100]);
  assert.deepEqual([lo(2), hi(2)], [200, 400]);
  assert.equal(hi(10), 1000);
  assert.equal(retryDelayMs(0, { retryAfterMs: 3000, maxMs: 8000 }), 3000);
  assert.equal(retryDelayMs(0, { retryAfterMs: 99999, maxMs: 8000 }), 8000);
});

test('a retryable status is retried on the same server and then succeeds', async () => {
  const sleeps = [];
  const pool = new EndpointPool(['http://a/v1'], { retries: 2, sleep: async (ms) => sleeps.push(ms), random: () => 0 });
  const answers = [res(503), res(429, { 'retry-after': '1' }), res(200)];
  const out = await pool.fetch('/chat/completions', {}, { fetchImpl: async () => answers.shift() });
  assert.equal(out.status, 200);
  assert.deepEqual(sleeps, [200, 1000]);
});

test('a dead first server fails over to the second, and a client error is not retried', async () => {
  const seen = [];
  const pool = new EndpointPool(['http://a/v1', 'http://b/v1'], { retries: 1, ...noSleep });
  const out = await pool.fetch('/x', {}, { fetchImpl: async (url) => { seen.push(url); if (url.startsWith('http://a')) throw new Error('ECONNREFUSED'); return res(200); } });
  assert.equal(out.status, 200);
  assert.deepEqual(seen, ['http://a/v1/x', 'http://a/v1/x', 'http://b/v1/x']);

  const calls = [];
  const bad = await new EndpointPool(['http://a/v1', 'http://b/v1'], noSleep).fetch('/x', {}, { fetchImpl: async (u) => { calls.push(u); return res(400); } });
  assert.equal(bad.status, 400);
  assert.equal(calls.length, 1);
});

test('when every server errors, the last response is returned so its message can surface', async () => {
  const pool = new EndpointPool(['http://a/v1', 'http://b/v1'], { retries: 0, ...noSleep });
  const out = await pool.fetch('/x', {}, { fetchImpl: async () => res(503) });
  assert.equal(out.status, 503);
  const down = new EndpointPool(['http://a/v1'], { retries: 0, ...noSleep });
  await assert.rejects(() => down.fetch('/x', {}, { fetchImpl: async () => { throw new Error('refused'); } }), /refused/);
});

test('the circuit breaker opens after repeated failures, skips the server, then probes once after cooldown', async () => {
  let t = 0;
  const b = new CircuitBreaker({ failures: 2, cooldownMs: 1000, now: () => t });
  b.failure(); assert.equal(b.state, 'closed');
  b.failure(); assert.equal(b.state, 'open');
  assert.equal(b.allow(), false);
  t = 1500;
  assert.equal(b.state, 'half-open');
  assert.equal(b.allow(), true);
  assert.equal(b.allow(), false, 'only one probe at a time');
  b.success();
  assert.equal(b.state, 'closed');

  const pool = new EndpointPool(['http://a/v1', 'http://b/v1'], { retries: 0, breaker: { failures: 1, cooldownMs: 60000 }, ...noSleep });
  const seen = [];
  const f = async (url) => { seen.push(url); return url.startsWith('http://a') ? res(500) : res(200); };
  await pool.fetch('/x', {}, { fetchImpl: f });
  seen.length = 0;
  await pool.fetch('/x', {}, { fetchImpl: f });
  assert.deepEqual(seen, ['http://b/v1/x'], 'the tripped server is skipped');
  assert.equal(pool.health()[0].state, 'open');

  const allDown = new EndpointPool(['http://a/v1'], { retries: 0, breaker: { failures: 1, cooldownMs: 60000 }, ...noSleep });
  await allDown.fetch('/x', {}, { fetchImpl: async () => res(500) });
  await assert.rejects(() => allDown.fetch('/x', {}, { fetchImpl: async () => res(200) }), /cooling down/);
});

test('an aborted request is never retried', async () => {
  const ctl = new AbortController();
  const pool = new EndpointPool(['http://a/v1'], { retries: 3, ...noSleep });
  let n = 0;
  await assert.rejects(() => pool.fetch('/x', { signal: ctl.signal }, { fetchImpl: async () => { n++; ctl.abort(); throw new Error('aborted'); } }));
  assert.equal(n, 1);
});

test('URL lists are split, trimmed and de-slashed', () => {
  assert.deepEqual(parseUrls(' http://a/v1/ , http://b/v1 ,, '), ['http://a/v1', 'http://b/v1']);
  assert.deepEqual(parseUrls('', ['d']), ['d']);
});

test('credentials are redacted from prompts, ordinary text is left alone', () => {
  const key = ['ghp_', 'A'.repeat(36)].join('');
  const aws = ['AKIA', 'B'.repeat(16)].join('');
  const { text, count } = redactSecrets(`token ${key} and ${aws}\n-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\nAuthorization: Bearer ${'x'.repeat(30)}`);
  assert.equal(count, 4);
  assert.ok(!text.includes(key) && !text.includes(aws) && !text.includes('abc'));
  assert.match(text, /\[REDACTED:github-token\]/);
  assert.match(text, /Bearer \[REDACTED:bearer-token\]/);
  assert.equal(redactSecrets('Summarize the Q3 plan for AKIA-style naming.').count, 0);
  const m = redactMessages([{ role: 'user', content: [{ type: 'text', text: `key ${key}` }] }, { role: 'system', content: 'hi' }]);
  assert.equal(m.count, 1);
  assert.match(m.messages[0].content[0].text, /REDACTED/);
});

test('openWeightsFetch redacts the prompt, fails over between listed servers, and honours the opt-out', async () => {
  process.env.OPEN_WEIGHTS_URL = 'http://gpu1/v1, http://gpu2/v1';
  process.env.OPEN_WEIGHTS_RETRIES = '0';
  assert.deepEqual(openWeightsUrls(), ['http://gpu1/v1', 'http://gpu2/v1']);
  const key = ['sk-ant-', 'q'.repeat(30)].join('');
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url, body: init.body }); return url.startsWith('http://gpu1') ? res(502) : res(200); };
  const out = await openWeightsFetch('/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `use ${key}` }] }) });
  assert.equal(out.status, 200);
  assert.deepEqual(seen.map((s) => s.url), ['http://gpu1/v1/chat/completions', 'http://gpu2/v1/chat/completions']);
  assert.ok(seen.every((s) => !s.body.includes(key) && s.body.includes('REDACTED:anthropic-key')));

  process.env.OPEN_WEIGHTS_REDACT = 'off';
  process.env.OPEN_WEIGHTS_URL = 'http://gpu3/v1';
  seen.length = 0;
  globalThis.fetch = async (url, init) => { seen.push({ url, body: init.body }); return res(200); };
  await openWeightsFetch('/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: key }] }) });
  assert.ok(seen[0].body.includes(key));
});
