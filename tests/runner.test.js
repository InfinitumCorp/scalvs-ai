import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const store = await import('../src/store.js');
const runner = await import('../src/runner.js');
const tick = async (predicate) => {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Run did not reach expected state');
};
beforeEach(async () => {
  store.reset();
  globalThis.fetch = async () => Response.json({ live: true });
  await runner.checkLive();
});

test('rejects empty tasks and missing agents without starting work', () => {
  const id = store.getState().agents[0].id;
  assert.ok(runner.startRun({ task: '   ', agentIds: [id] }).error);
  assert.ok(runner.startRun({ task: 'test', agentIds: [id, 'missing'] }).error);
  assert.equal(store.getState().runs.length, 0);
});

test('approval and rejection are safe for unknown or inactive runs', () => {
  assert.doesNotThrow(() => runner.approve('missing'));
  store.update(s => s.runs.push({ id: 'finished', status: 'completed', current: 1, steps: [{ status: 'done' }] }));
  assert.doesNotThrow(() => runner.approve('finished'));
  runner.reject('finished');
  assert.equal(store.getState().runs[0].status, 'completed');
});

test('provider errors fail the run without awarding tokens', async () => {
  globalThis.fetch = async () => Response.json({ error: 'Provider unavailable' }, { status: 502 });
  const { run } = runner.startRun({ task: 'Draft a memo', agentIds: [store.getState().agents[0].id] });
  await tick(() => run.status === 'failed');
  assert.match(run.error, /Provider unavailable/);
  assert.equal(store.getState().wallet.sclv, 0);
});

test('empty live output is a failure', async () => {
  globalThis.fetch = async () => Response.json({ mode: 'live', output: '   ' });
  const { run } = runner.startRun({ task: 'Draft a memo', agentIds: [store.getState().agents[0].id] });
  await tick(() => run.status !== 'running');
  assert.equal(run.status, 'failed');
});

test('completed model output is not verified contribution evidence', async () => {
  globalThis.fetch = async () => Response.json({ mode: 'live', output: 'A real draft.' });
  const { run } = runner.startRun({ task: 'Draft a memo', agentIds: [store.getState().agents[0].id] });
  await tick(() => run.status === 'completed');
  assert.equal(run.verified, false);
  assert.equal(store.getState().wallet.sclv, 0);
  assert.equal(store.getState().wallet.activity, 0);
});

test('demo completion stays unverified with no automatic rewards', async () => {
  globalThis.fetch = async () => Response.json({ live: false });
  await runner.checkLive();
  const { run } = runner.startRun({ task: 'Test the interface', agentIds: [store.getState().agents[0].id] });
  await tick(() => run.status === 'completed');
  assert.equal(run.steps[0].mode, 'demo');
  assert.equal(run.verified, false);
  assert.equal(store.getState().wallet.sclv, 0);
});

test('duplicate approval cannot skip a team step or change completion', async () => {
  globalThis.fetch = async () => Response.json({ mode: 'live', output: 'Draft for review.' });
  const ids = store.getState().agents.map(a => a.id);
  const { run } = runner.startRun({ task: 'Write a brief', agentIds: [ids[1], ids[0]] });
  await tick(() => run.status === 'awaiting_approval');
  runner.approve(run.id);
  runner.approve(run.id);
  await tick(() => run.status === 'completed');
  assert.equal(run.current, 2);
  assert.ok(run.steps.every(s => s.status === 'done'));
  runner.reject(run.id);
  assert.equal(run.status, 'completed');
});

test('team reservations prevent concurrent runs from overspending the allowance', async () => {
  const finishes = [];
  globalThis.fetch = () => new Promise(resolve => { finishes.push(resolve); });
  store.update(s => { s.wallet.creditsUsed = 176; });
  const ids = store.getState().agents.map(a => a.id);
  const { run } = runner.startRun({ task: 'Two steps', agentIds: [ids[1], ids[0]] });
  const second = runner.startRun({ task: 'Another run', agentIds: [ids[0]] });
  finishes.forEach(resolve => resolve(Response.json({ mode: 'live', output: 'First step' })));
  await tick(() => run.status === 'awaiting_approval');
  runner.reject(run.id);
  assert.ok(second.error, 'the queued step must reserve its 12 credits');
  assert.equal(store.getState().wallet.creditsUsed, 188);
  assert.equal(runner.creditUsage().reserved, 0);
  assert.equal(runner.creditUsage().available, 12);
});

test('resuming after a plan downgrade never charges over the new limit', async () => {
  store.update(s => { s.plan = 'pro'; s.wallet.creditsUsed = 200; });
  globalThis.fetch = async () => Response.json({ mode: 'live', output: 'Draft' });
  const ids = store.getState().agents.map(a => a.id);
  const { run } = runner.startRun({ task: 'Two steps', agentIds: [ids[1], ids[0]] });
  await tick(() => run.status === 'awaiting_approval');
  store.update(s => { s.plan = 'free'; });
  runner.approve(run.id);
  assert.equal(run.status, 'failed');
  assert.equal(store.getState().wallet.creditsUsed, 212);
  assert.equal(runner.creditUsage().reserved, 0);
});

test('monthly usage rolls over while other balances remain intact', () => {
  store.update(s => {
    s.wallet.creditMonth = '1999-01';
    s.wallet.creditsUsed = 200;
    s.wallet.sclv = 7;
  });
  const s = store.getState();
  assert.equal(s.wallet.creditsUsed, 0);
  assert.equal(s.wallet.creditMonth, new Date().toISOString().slice(0, 7));
  assert.equal(s.wallet.sclv, 7);
});

test('new runs do not discard active runs when history reaches 40 entries', async () => {
  store.update(s => {
    s.plan = 'government';
    s.runs = Array.from({ length: 40 }, (_, n) => ({ id: `active-${n}`, status: 'awaiting_approval', steps: [{ status: 'awaiting_approval' }] }));
  });
  globalThis.fetch = async () => Response.json({ mode: 'live', output: 'Draft' });
  const { run } = runner.startRun({ task: 'One more run', agentIds: [store.getState().agents[0].id] });
  await tick(() => run.status === 'completed');
  assert.ok(store.getState().runs.some(r => r.id === 'active-39'));
});
