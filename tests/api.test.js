import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../api/run.js';

const originalFetch = globalThis.fetch;
const originalKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
});
const request = () => new Request('http://localhost/api/run', { method: 'POST', body: JSON.stringify({ task: 'Draft a memo' }) });

test('unconfigured runtime explicitly reports demo mode', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const response = await POST(request());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).mode, 'demo');
});

test('network failures become retryable JSON errors', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-only';
  globalThis.fetch = async () => { throw new Error('private infrastructure detail'); };
  const response = await POST(request());
  assert.equal(response.status, 502);
  assert.equal(JSON.stringify(await response.json()).includes('private infrastructure'), false);
});

test('empty provider output is never a successful live run', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-only';
  globalThis.fetch = async () => Response.json({ content: [] });
  assert.equal((await POST(request())).status, 502);
});

test('successful runtime output includes the provider result', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-only';
  globalThis.fetch = async () => Response.json({ model: 'test-model', content: [{ type: 'text', text: 'Draft memo' }], usage: { input_tokens: 4, output_tokens: 2 } });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, 'live');
  assert.equal(body.output, 'Draft memo');
});
