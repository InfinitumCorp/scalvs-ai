// The shared Workers AI ledger: SCALVS.ai is refused, not billed, past the account's free allowance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

function ledger(limit) {
  let used = 0;
  const stub = {
    reserve: async (_l, amount) => (used + amount > limit ? { ok: false, used, limit } : ((used += amount), { ok: true, used, limit })),
    settle: async (_d, reserved, actual) => { used = used - reserved + actual; },
  };
  return { ns: { idFromName: () => 'daily', get: () => stub }, used: () => used };
}

const ctx = { waitUntil: (p) => p };
const imagine = (env) =>
  worker.fetch(new Request('https://scalvs.test/api/imagine', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'a lighthouse at dawn' }) }), env, ctx);

test('past the free allowance a model route answers 429 and the model is not called', async () => {
  let ran = false;
  const env = { AI: { run: async () => { ran = true; return {}; } }, AI_BUDGET: ledger(0).ns, ASSETS: { fetch: () => new Response('') } };
  const res = await imagine(env);
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /free daily AI allowance is used up/);
  assert.equal(ran, false);
});

test('within the allowance the call goes through and is charged', async () => {
  const l = ledger(1000);
  const env = { AI: { run: async () => ({ image: 'aGVsbG8=' }) }, AI_BUDGET: l.ns, ASSETS: { fetch: () => new Response('') } };
  const res = await imagine(env);
  assert.notEqual(res.status, 429);
  assert.equal(l.used(), 100); // image calls keep their flat reservation
});
