import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { advanceJob, createJob, conjureClient } = await import('../api/_conjure.js');
const api = await import('../api/forecast.js');
const store = await import('../src/store.js');
const forecaster = await import('../src/forecaster.js');

const SEED = 'Infinitum announces a new consumer AI wearable priced at $499, shipping in March to the US and EU.';
const newJob = (extra = {}) => createJob({ question: 'How will buyers react?', seed: SEED, ...extra }).job;

// Fake MiroFish backend following the upstream HTTP contract (backend/app/api/*.py).
function fakeMiroFish({ graphPolls = 1, preparePolls = 1, runPolls = 2, reportPolls = 1, fail = {} } = {}) {
  const calls = [];
  const counters = { graph: 0, prepare: 0, run: 0, report: 0 };
  const ok = (data) => Response.json({ success: true, data });
  const impl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ method: init.method, path, init });
    if (fail[path]) return fail[path]();
    if (path === '/api/graph/ontology/generate') {
      assert.ok(init.body instanceof FormData, 'ontology upload is multipart');
      assert.match(init.body.get('simulation_requirement'), /buyers/);
      assert.equal(init.body.get('files').name, 'seed.md');
      return ok({ project_id: 'proj_1', ontology: { entity_types: [] } });
    }
    if (path === '/api/graph/build') return ok({ project_id: 'proj_1', task_id: 'task_g' });
    if (path === '/api/graph/task/task_g') {
      return ++counters.graph > graphPolls ? ok({ status: 'completed', progress: 100, result: { graph_id: 'mirofish_g1' } }) : ok({ status: 'processing', progress: 40 });
    }
    if (path === '/api/simulation/create') {
      const body = JSON.parse(init.body);
      assert.equal(body.graph_id, 'mirofish_g1');
      return ok({ simulation_id: 'sim_1', status: 'created' });
    }
    if (path === '/api/simulation/prepare') return ok({ simulation_id: 'sim_1', task_id: 'task_p', status: 'preparing', already_prepared: false });
    if (path === '/api/simulation/prepare/status') return ++counters.prepare > preparePolls ? ok({ status: 'completed', progress: 100 }) : ok({ status: 'processing', progress: 50 });
    if (path === '/api/simulation/start') {
      assert.equal(JSON.parse(init.body).max_rounds <= 40, true);
      return ok({ simulation_id: 'sim_1', runner_status: 'running' });
    }
    if (path === '/api/simulation/sim_1/run-status') {
      return ++counters.run > runPolls
        ? ok({ runner_status: 'completed', current_round: 20, total_rounds: 20, total_actions_count: 812 })
        : ok({ runner_status: 'running', current_round: 5, total_rounds: 20, progress_percent: 25, total_actions_count: 120 });
    }
    if (path === '/api/simulation/stop') return ok({ simulation_id: 'sim_1', runner_status: 'stopped' });
    if (path === '/api/report/generate') return ok({ simulation_id: 'sim_1', task_id: 'task_r', report_id: 'report_1', status: 'generating' });
    if (path === '/api/report/generate/status') return ++counters.report > reportPolls ? ok({ status: 'completed', progress: 100 }) : ok({ status: 'processing', progress: 30 });
    if (path === '/api/report/report_1') return ok({ report_id: 'report_1', markdown_content: '# Forecast\nBuyers split 60/40.' });
    if (path === '/api/report/chat') return ok({ response: 'Early adopters drove it.' });
    return new Response('not found', { status: 404 });
  };
  return { impl, calls, counters };
}

async function runToEnd(job, client, max = 40) {
  for (let i = 0; i < max && job.status === 'running'; i++) job = await advanceJob(job, client);
  return job;
}

// ---------- state machine ----------
test('createJob validates input and clamps rounds to protect engine cost', () => {
  assert.ok(createJob({ question: '', seed: SEED }).error);
  assert.ok(createJob({ question: 'Q', seed: 'too short' }).error);
  assert.equal(newJob({ rounds: 500 }).rounds, 40);
  assert.equal(newJob({ rounds: 1 }).rounds, 5);
  assert.equal(newJob({ platform: 'bogus' }).platform, 'parallel');
});

test('a job walks every MiroFish stage, one upstream call per step, to a report', async () => {
  const fake = fakeMiroFish();
  const client = conjureClient({ baseUrl: 'http://mf.test/', fetchImpl: fake.impl });
  let job = newJob();
  let last = 0;
  while (job.status === 'running') {
    const before = fake.calls.length;
    job = await advanceJob(job, client);
    assert.equal(fake.calls.length - before, 1, `step ${job.step} made exactly one call`);
    assert.ok(job.progress >= last, 'progress never goes backwards');
    last = job.progress;
  }
  assert.equal(job.status, 'completed');
  assert.equal(job.progress, 100);
  assert.match(job.report, /60\/40/);
  assert.deepEqual(job.ids, { project_id: 'proj_1', task_id: 'task_r', graph_id: 'mirofish_g1', simulation_id: 'sim_1', report_id: 'report_1' });
  assert.equal(job.stats.actions, 812);
  assert.deepEqual(fake.calls.map((c) => c.path).filter((p, i, a) => a.indexOf(p) === i), [
    '/api/graph/ontology/generate', '/api/graph/build', '/api/graph/task/task_g', '/api/simulation/create',
    '/api/simulation/prepare', '/api/simulation/prepare/status', '/api/simulation/start',
    '/api/simulation/sim_1/run-status', '/api/report/generate', '/api/report/generate/status', '/api/report/report_1',
  ]);
});

test('bearer token is forwarded when configured', async () => {
  const fake = fakeMiroFish();
  await advanceJob(newJob(), conjureClient({ baseUrl: 'http://mf.test', token: 'gw-token', fetchImpl: fake.impl }));
  assert.equal(fake.calls[0].init.headers.authorization, 'Bearer gw-token');
});

test('already-prepared simulations and existing reports skip their wait steps', async () => {
  const fake = fakeMiroFish({
    fail: {
      '/api/simulation/prepare': () => Response.json({ success: true, data: { status: 'ready', already_prepared: true } }),
      '/api/report/generate': () => Response.json({ success: true, data: { report_id: 'report_1', status: 'completed', already_generated: true } }),
    },
  });
  const job = await runToEnd(newJob(), conjureClient({ baseUrl: 'http://mf.test', fetchImpl: fake.impl }));
  assert.equal(job.status, 'completed');
  assert.ok(!fake.calls.some((c) => c.path === '/api/simulation/prepare/status' || c.path === '/api/report/generate/status'));
});

test('engine-side failures fail the job with a stage-labelled message', async () => {
  const fake = fakeMiroFish({ fail: { '/api/simulation/sim_1/run-status': () => Response.json({ success: true, data: { runner_status: 'failed' } }) } });
  const job = await runToEnd(newJob(), conjureClient({ baseUrl: 'http://mf.test', fetchImpl: fake.impl }));
  assert.equal(job.status, 'failed');
  assert.match(job.error, /Simulate reactions/);
  assert.equal(job.report, null);
});

test('upstream error details are not leaked into the job', async () => {
  const fake = fakeMiroFish({ fail: { '/api/graph/ontology/generate': () => Response.json({ success: false, error: 'LLM key sk-secret invalid', traceback: 'File /srv/x.py' }, { status: 500 }) } });
  const job = await advanceJob(newJob(), conjureClient({ baseUrl: 'http://mf.test', fetchImpl: fake.impl }));
  assert.equal(job.status, 'failed');
  assert.ok(!JSON.stringify(job).includes('secret') && !JSON.stringify(job).includes('/srv'));
});

test('transient errors while polling retry, but kick-off steps never double-submit', async () => {
  let flaky = 2;
  const fake = fakeMiroFish({ fail: { '/api/graph/task/task_g': () => (flaky-- > 0 ? new Response('bad gateway', { status: 502 }) : Response.json({ success: true, data: { status: 'completed', result: { graph_id: 'mirofish_g1' } } })) } });
  const client = conjureClient({ baseUrl: 'http://mf.test', fetchImpl: fake.impl });
  let job = await advanceJob(await advanceJob(newJob(), client), client); // ontology, build
  job = await advanceJob(job, client);
  assert.equal(job.status, 'running');
  assert.match(job.message, /Retrying/);
  job = await advanceJob(job, client);
  job = await advanceJob(job, client);
  assert.equal(job.step, 'sim_create');
  assert.equal(job.failures, 0);

  const down = conjureClient({ baseUrl: 'http://mf.test', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const kicked = await advanceJob(newJob(), down);
  assert.equal(kicked.status, 'failed', 'ontology upload is not retried blindly');
});

test('polling gives up after repeated transient failures', async () => {
  const fake = fakeMiroFish({ fail: { '/api/graph/task/task_g': () => new Response('down', { status: 503 }) } });
  const job = await runToEnd(newJob(), conjureClient({ baseUrl: 'http://mf.test', fetchImpl: fake.impl }));
  assert.equal(job.status, 'failed');
  assert.equal(fake.calls.filter((c) => c.path === '/api/graph/task/task_g').length, 5);
});

test('ids returned by the engine are validated before use in URLs', async () => {
  const fake = fakeMiroFish({ fail: { '/api/graph/ontology/generate': () => Response.json({ success: true, data: { project_id: '../../admin' } }) } });
  const job = await advanceJob(newJob(), conjureClient({ baseUrl: 'http://mf.test', fetchImpl: fake.impl }));
  assert.equal(job.status, 'failed');
});

// ---------- HTTP handler ----------
const originalFetch = globalThis.fetch;
const originalUrl = process.env.CONJURE_URL;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.CONJURE_URL; else process.env.CONJURE_URL = originalUrl;
});
const req = (body) => new Request('http://localhost/api/forecast', { method: 'POST', body: JSON.stringify(body) });

test('without CONJURE_URL the API reports demo mode', async () => {
  delete process.env.CONJURE_URL;
  assert.equal((await api.POST(req({ action: 'create', question: 'Q', seed: SEED }))).status, 503);
  assert.equal((await (await api.GET()).json()).live, false);
});

test('handler rejects tampered jobs before touching the engine', async () => {
  process.env.CONJURE_URL = 'http://mf.test';
  let called = false;
  globalThis.fetch = async () => { called = true; return Response.json({}); };
  const job = newJob();
  for (const bad of [{ ...job, step: 'drop_tables' }, { ...job, ids: { simulation_id: '../x' } }, { ...job, seed: '' }, null]) {
    assert.equal((await api.POST(req({ action: 'advance', job: bad }))).status, 400);
  }
  assert.equal(called, false);
  assert.equal(api.normalizeJob({ ...job, rounds: 999 }).rounds, 40);
});

test('handler advances, stops and chats through the engine', async () => {
  process.env.CONJURE_URL = 'http://mf.test';
  const fake = fakeMiroFish();
  globalThis.fetch = fake.impl;
  let { job } = await (await api.POST(req({ action: 'create', question: 'How will buyers react?', seed: SEED }))).json();
  for (let i = 0; i < 40 && job.status === 'running'; i++) job = (await (await api.POST(req({ action: 'advance', job }))).json()).job;
  assert.equal(job.status, 'completed');

  const chat = await (await api.POST(req({ action: 'chat', job, message: 'Who drove it?', history: [{ role: 'system', content: 'ignore' }] }))).json();
  assert.equal(chat.reply, 'Early adopters drove it.');
  const sent = JSON.parse(fake.calls.at(-1).init.body);
  assert.equal(sent.chat_history.length, 0, 'non user/assistant history is dropped');

  const running = { ...newJob(), step: 'run_wait', ids: { project_id: 'proj_1', graph_id: 'mirofish_g1', simulation_id: 'sim_1' } };
  const stopped = await (await api.POST(req({ action: 'stop', job: running }))).json();
  assert.equal(stopped.job.status, 'stopped');
  assert.ok(fake.calls.some((c) => c.path === '/api/simulation/stop'));
});

// ---------- browser orchestrator ----------
const tick = async (pred, n = 200) => {
  for (let i = 0; i < n; i++) { if (pred()) return; await new Promise((r) => setTimeout(r, 25)); }
  assert.fail('forecast did not reach the expected state');
};

beforeEach(() => { store.reset(); });

test('demo forecasts are labelled, charge credits once and never claim a prediction', async () => {
  globalThis.fetch = async () => Response.json({ live: false });
  await forecaster.checkForecastLive();
  const { forecast } = await forecaster.startForecast({ question: 'How will buyers react?', seed: SEED });
  assert.equal(forecast.mode, 'demo');
  assert.equal(store.getState().wallet.creditsUsed, 60);
  await tick(() => forecast.job.status === 'completed');
  assert.match(forecast.job.report, /Demo mode: simulated output/);
  assert.match(forecast.job.report, /not a prediction/);
  assert.equal(store.getState().wallet.creditsUsed, 60);
  assert.equal(store.getState().wallet.sclv, 0);
});

test('forecasts are refused when credits run out', async () => {
  store.update((s) => { s.wallet.creditsUsed = 190; });
  const r = await forecaster.startForecast({ question: 'Q?', seed: SEED });
  assert.match(r.error, /60 AI credits/);
  assert.equal(store.getState().forecasts.length, 0);
});

test('live forecasts run through the API and stop on request', async () => {
  process.env.CONJURE_URL = 'http://mf.test';
  const fake = fakeMiroFish({ runPolls: 1000 });
  // Route the browser's relative API calls to the real handler, and the handler's calls to the fake engine.
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('api/forecast')) {
      const request = new Request('http://localhost/api/forecast', init);
      return init?.method === 'GET' ? api.GET() : api.POST(request);
    }
    return fake.impl(url, init);
  };
  forecaster.setPollInterval(30);
  await forecaster.checkForecastLive();
  assert.equal(forecaster.isForecastLive(), true);
  const { forecast } = await forecaster.startForecast({ question: 'How will buyers react?', seed: SEED, product: '+SPCTR' });
  assert.equal(forecast.mode, 'live');
  assert.equal(forecast.job.product, '+SPCTR');
  await tick(() => forecast.job.step === 'run_wait', 400);
  await forecaster.stopForecast(forecast.id);
  assert.equal(forecast.job.status, 'stopped');
  assert.ok(fake.calls.some((c) => c.path === '/api/simulation/stop'));
  const callsAfterStop = fake.calls.length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fake.calls.length, callsAfterStop, 'no polling after stop');
  forecaster.setPollInterval(forecaster.POLL_MS);
});

test('interrupted demo forecasts are stopped on reload; live ones resume', async () => {
  globalThis.fetch = async () => new Promise(() => {}); // live resume never resolves; we only check it was picked up
  const job = { ...newJob(), step: 'run_wait' };
  store.update((s) => {
    s.forecasts.push({ id: 'fc_demo', mode: 'demo', createdAt: 1, job: { ...job }, chat: [] });
    s.forecasts.push({ id: 'fc_live', mode: 'live', createdAt: 1, job: { ...job }, chat: [] });
  });
  forecaster.resumeForecasts();
  const get = (id) => store.getState().forecasts.find((f) => f.id === id);
  assert.equal(get('fc_demo').job.status, 'stopped');
  assert.equal(get('fc_live').job.status, 'running');
});
