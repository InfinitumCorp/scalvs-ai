import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyExchange, setConsent, withdrawAll, hasConsent, available, quoteSale, applySale, collect,
  SHARE, SCLV_PER_USD, CATEGORIES,
} from '../src/exchange.js';

const state = (runs = [], forecasts = []) => ({ runs, forecasts });
const run = (id, task, status = 'completed') => ({ id, task, status });

test('nothing is sold without consent', () => {
  const ex = emptyExchange();
  const s = state([run('r1', 'Compare the best CRMs')]);
  const q = quoteSale(s, ex, 'ads');
  assert.equal(q.lines.length, 0);
  assert.match(q.blocked, /not allowed/);
  assert.equal(applySale(ex, q), 0);
});

test('consent is per category and per buyer', () => {
  const ex = emptyExchange();
  setConsent(ex, 'interests', 'ads', true);
  const s = state([run('r1', 'Compare the best CRMs')]);
  const ads = quoteSale(s, ex, 'ads');
  assert.deepEqual(ads.lines.map((l) => l.category), ['interests']);
  assert.match(quoteSale(s, ex, 'brokers').blocked, /not allowed/);
  assert.equal(setConsent(ex, 'messages', 'ads', true), false, 'unknown categories cannot be consented');
});

test('Global Privacy Control blocks every sale', () => {
  const ex = emptyExchange();
  for (const c of CATEGORIES) setConsent(ex, c.id, 'ads', true);
  const q = quoteSale(state([run('r1', 'x')]), ex, 'ads', { gpc: true });
  assert.equal(q.lines.length, 0);
  assert.match(q.blocked, /Global Privacy Control/);
});

test('the person gets their share in $SCLV and points are not sold twice', () => {
  const ex = emptyExchange();
  setConsent(ex, 'usage', 'ads', true);
  const s = state([run('r1', 'Write a post'), run('r2', 'Plan a launch')]);
  const q = quoteSale(s, ex, 'ads');
  const line = q.lines[0];
  assert.equal(line.points, 6);
  assert.equal(line.shareUsd, Math.round(line.grossUsd * SHARE * 100) / 100);
  assert.equal(line.sclv, Math.round(line.shareUsd * SCLV_PER_USD * 100) / 100);
  assert.equal(applySale(ex, q), q.sclv);
  assert.equal(available(s, ex).usage, 0);
  assert.match(quoteSale(s, ex, 'ads').blocked, /No new data/);
  assert.equal(ex.receipts.length, 1);
});

test('withdrawing consent stops future sales', () => {
  const ex = emptyExchange();
  setConsent(ex, 'usage', 'brokers', true);
  withdrawAll(ex);
  assert.equal(hasConsent(ex, 'usage', 'brokers'), false);
  assert.match(quoteSale(state([run('r1', 'x')]), ex, 'brokers').blocked, /not allowed/);
});

test('activity is credited once, and pruning old runs keeps earned points', () => {
  const ex = emptyExchange();
  collect(state([run('r1', 'Compare vendors', 'running')]), ex);
  assert.deepEqual(ex.points, { usage: 3, intent: 2, region: 1 });
  collect(state([run('r1', 'Compare vendors', 'completed')]), ex);
  assert.equal(ex.points.interests, 2);
  assert.equal(ex.points.usage, 3, 'the same run is not counted twice');
  collect(state([]), ex);
  assert.equal(ex.points.usage, 3, 'removing the run does not remove points');
});

test('forecasts from excluded products never contribute', () => {
  const ex = emptyExchange();
  const f = (id, product) => ({ id, job: { product, status: 'completed', question: 'q' } });
  collect(state([], [f('f1', 'ODIN°'), f('f2', 'DAEMON')]), ex);
  assert.deepEqual(ex.points, {});
  collect(state([], [f('f3', '+SPCTR')]), ex);
  assert.equal(ex.points.usage, 5);
});
