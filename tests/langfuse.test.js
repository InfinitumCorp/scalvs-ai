// Langfuse tracing of Workers AI calls: off without keys, metadata-only by default, never breaks a call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { langfuseFromEnv, tracedAI, generationSpan } from '../api/_ai-langfuse.mjs';

const KEYS = { LANGFUSE_PUBLIC_KEY: 'pk-lf-test', LANGFUSE_SECRET_KEY: 'sk-lf-test' };
const fakeAI = (result) => ({ run: async (model, input) => (typeof result === 'function' ? result(model, input) : result), models: () => ['m'] });
const attrs = (body) => Object.fromEntries(body.resourceSpans[0].scopeSpans[0].spans[0].attributes.map((a) => [a.key, a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue]));

test('off without both keys, with LANGFUSE=off, or with a non-https base URL', () => {
  assert.equal(langfuseFromEnv({}), null);
  assert.equal(langfuseFromEnv({ LANGFUSE_PUBLIC_KEY: 'pk' }), null);
  assert.equal(langfuseFromEnv({ ...KEYS, LANGFUSE: 'off' }), null);
  assert.equal(langfuseFromEnv({ ...KEYS, LANGFUSE_BASE_URL: 'http://evil.example' }), null);
  const ai = fakeAI({});
  assert.equal(tracedAI(ai, null), ai);
});

test('one OTLP span per call to the v4 endpoint with Basic auth; no prompt or reply by default', async () => {
  const sent = [];
  const tracer = langfuseFromEnv({ ...KEYS, LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com/' }, { product: 'scalvs', fetch: async (url, init) => { sent.push({ url, init }); return new Response('{}'); } });
  const waits = [];
  const ai = tracedAI(fakeAI({ response: 'secret reply', usage: { prompt_tokens: 12, completion_tokens: 30 } }), tracer, { waitUntil: (p) => waits.push(p) });
  const r = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages: [{ role: 'user', content: 'private prompt' }] });
  assert.equal(r.response, 'secret reply');
  assert.deepEqual(ai.models(), ['m']);
  await Promise.all(waits);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://us.cloud.langfuse.com/api/public/otel/v1/traces');
  assert.equal(sent[0].init.headers.authorization, `Basic ${btoa('pk-lf-test:sk-lf-test')}`);
  assert.equal(sent[0].init.headers['x-langfuse-ingestion-version'], '4');
  assert.doesNotMatch(sent[0].init.body, /private prompt|secret reply/);
  const a = attrs(JSON.parse(sent[0].init.body));
  assert.equal(a['langfuse.observation.type'], 'generation');
  assert.equal(a['langfuse.observation.model.name'], '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.deepEqual(JSON.parse(a['langfuse.observation.usage_details']), { input: 12, output: 30, total: 42 });
  assert.equal(a['langfuse.observation.metadata.product'], 'scalvs');
});

test('LANGFUSE_CAPTURE_CONTENT=on adds input and output', async () => {
  const sent = [];
  const tracer = langfuseFromEnv({ ...KEYS, LANGFUSE_CAPTURE_CONTENT: 'on' }, { product: 'scalvs', fetch: async (url, init) => { sent.push(init.body, url); return new Response('{}'); } });
  const waits = [];
  await tracedAI(fakeAI({ response: 'the reply' }), tracer, { waitUntil: (p) => waits.push(p) }).run('m', { messages: [{ role: 'user', content: 'the prompt' }] });
  await Promise.all(waits);
  assert.match(sent[0], /the prompt/);
  assert.match(sent[0], /the reply/);
  assert.equal(sent[1], 'https://cloud.langfuse.com/api/public/otel/v1/traces');
});

test('a model error is traced as ERROR and rethrown; a Langfuse outage never breaks the call', async () => {
  const sent = [];
  const tracer = langfuseFromEnv(KEYS, { product: 'scalvs', fetch: async (url, init) => { sent.push(init.body); throw new Error('langfuse down'); } });
  const waits = [];
  const failing = tracedAI(fakeAI(() => { throw new Error('model 500'); }), tracer, { waitUntil: (p) => waits.push(p) });
  await assert.rejects(failing.run('m', {}), /model 500/);
  const ok = tracedAI(fakeAI({ response: 'fine' }), tracer, { waitUntil: (p) => waits.push(p) });
  assert.equal((await ok.run('m', {})).response, 'fine');
  await Promise.all(waits);
  assert.equal(attrs(JSON.parse(sent[0]))['langfuse.observation.level'], 'ERROR');
});

test('span ids and timestamps are OTLP-shaped', () => {
  const span = generationSpan({ product: 'scalvs', name: 'x', model: 'm', startMs: 1000, endMs: 1500 }).resourceSpans[0].scopeSpans[0].spans[0];
  assert.match(span.traceId, /^[0-9a-f]{32}$/);
  assert.match(span.spanId, /^[0-9a-f]{16}$/);
  assert.equal(span.startTimeUnixNano, '1000000000');
  assert.equal(span.endTimeUnixNano, '1500000000');
});
