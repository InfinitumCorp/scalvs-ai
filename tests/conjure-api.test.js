// Forecasts on Conjure's product API (/v1), against a fake Conjure server on a real socket.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const api = await import('../api/forecast.js');
const { advanceApiJob, apiClient, createApiJob, predictionRequest, reportMarkdown, conjureRounds } = await import('../api/_conjure-api.js');
const store = await import('../src/store.js');
const forecaster = await import('../src/forecaster.js');

const KEY = 'cjp_scalvs_test_key';
const SEED = 'Infinitum announces a new consumer AI wearable priced at $499, shipping in March to the US and EU.';

const REPORT = {
  outcome: 'Early adopters buy; mainstream buyers wait for reviews.',
  probability: 0.62,
  forecast: 'The launch lands well with enthusiasts while price-sensitive buyers hold back.',
  drivers: ['price point', 'EU availability'],
  signals: ['pre-order counts'],
  assumptions: ['ships on time'],
  confidence: 'medium',
};
const PERSONAS = [
  { id: 'a1', name: 'Mia Chen', role: 'tech reviewer', influence: 3 },
  { id: 'a2', name: 'Acme spokesperson', role: 'competitor', influence: 5 },
];

// Fake Conjure: each prediction is queued, plays `rounds` rounds one GET at a time, then is done.
function fakeConjure() {
  const state = { requests: [], predictions: new Map(), failStart: null, failGets: 0, outcome: 'done' };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; } // MiroFish sends multipart
    const url = new URL(req.url, 'http://x');
    state.requests.push({ method: req.method, path: url.pathname, search: url.search, auth: req.headers.authorization, body });
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (url.pathname.startsWith('/api/')) return send(404, { success: false }); // not a MiroFish engine
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'bad key' });

    if (req.method === 'POST' && url.pathname === '/v1/predictions') {
      if (state.failStart) return send(state.failStart.status, { error: state.failStart.error });
      const id = `pr_${state.predictions.size + 1}abc`;
      state.predictions.set(id, { id, question: body.question, rounds: body.rounds, agents: body.agents, gets: 0, status: 'queued', cancelled: false, interviews: [] });
      return send(202, { id, status: 'queued', round: 0, rounds: body.rounds, agents: body.agents });
    }
    const m = /^\/v1\/predictions\/([\w-]+)(?:\/(interview|cancel))?$/.exec(url.pathname);
    const p = m && state.predictions.get(m[1]);
    if (!p) return send(404, { error: 'no such prediction' });
    if (req.method === 'POST' && m[2] === 'cancel') { p.cancelled = true; return send(200, { cancelled: true }); }
    if (req.method === 'POST' && m[2] === 'interview') {
      p.interviews.push(body);
      return send(200, { answer: `As ${body.agentId}: price is the sticking point.` });
    }
    if (req.method === 'GET' && !m[2]) {
      if (state.failGets > 0) { state.failGets--; return send(503, { error: 'busy' }); }
      p.gets++;
      const round = Math.max(0, Math.min(p.rounds, p.gets - 2));
      const done = p.gets > p.rounds + 2;
      const view = {
        id: p.id, question: p.question, status: p.cancelled ? 'cancelled' : done ? state.outcome : p.gets === 1 ? 'queued' : 'running',
        round: done ? p.rounds : round, rounds: p.rounds, agents: p.agents,
        poles: { for: 'the wearable sells out in March', against: 'it misses' },
        stats: Array.from({ length: round + 1 }, (_, r) => ({ round: r, posts: r ? 4 : 0, replies: r ? 2 : 0, likes: r ? 5 : 0, reposts: r ? 1 : 0 })),
        report: done && state.outcome === 'done' ? REPORT : undefined,
        error: done && state.outcome === 'failed' ? 'model unavailable' : undefined,
      };
      if (url.searchParams.get('full') === '1') view.personas = PERSONAS;
      return send(200, view);
    }
    return send(405, { error: 'method not allowed' });
  });
  return { server, state };
}

let fake;
let baseUrl;
before(async () => {
  fake = fakeConjure();
  await new Promise((r) => fake.server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${fake.server.address().port}/`;
});
after(() => { fake.server.closeAllConnections(); fake.server.close(); });

const ENV_KEYS = ['CONJURE_URL', 'CONJURE_PRODUCT_KEY', 'CONJURE_TOKEN'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fake.state.requests.length = 0;
  Object.assign(fake.state, { failStart: null, failGets: 0, outcome: 'done' });
  forecaster.setPollInterval(forecaster.POLL_MS);
});
const useProductApi = () => { process.env.CONJURE_URL = baseUrl; process.env.CONJURE_PRODUCT_KEY = KEY; };
const req = (body) => new Request('http://localhost/api/forecast', { method: 'POST', body: JSON.stringify(body) });
const post = async (body) => { const r = await api.POST(req(body)); return { status: r.status, data: await r.json() }; };

async function runToEnd(job, max = 30) {
  for (let i = 0; i < max && job.status === 'running'; i++) job = (await post({ action: 'advance', job })).data.job;
  return job;
}

test('SCALVS rounds map onto Conjure rounds; long questions keep their full text in the context', () => {
  assert.deepEqual([10, 20, 40, 1, 999].map(conjureRounds), [2, 4, 8, 1, 8]);
  const long = 'Will buyers adopt it? '.repeat(40);
  const body = predictionRequest(createApiJob({ question: long, seed: SEED, product: '+SPCTR' }).job);
  assert.ok(body.question.length <= 500);
  assert.match(body.context, /Full question:/);
  assert.match(body.context, /Requested from \+SPCTR/);
  assert.match(body.context, /consumer AI wearable/);
  assert.equal(body.source, 'scalvs');
});

test('a forecast runs end to end on the product API and lands in the existing UI shape', async () => {
  useProductApi();
  assert.equal((await (await api.GET(new Request('http://localhost/api/forecast'))).json()).live, true);

  const created = await post({ action: 'create', question: 'How will buyers react?', seed: SEED, rounds: 20, product: 'SCALVS.ai' });
  assert.equal(created.status, 200);
  assert.equal(created.data.job.engine, 'conjure-api');
  assert.equal(fake.state.requests.length, 0, 'create only validates; the first advance starts the prediction');

  let job = created.data.job;
  const seen = new Set();
  let last = 0;
  while (job.status === 'running') {
    const before = fake.state.requests.length;
    job = (await post({ action: 'advance', job })).data.job;
    assert.equal(fake.state.requests.length - before, 1, 'one upstream request per advance');
    assert.ok(job.progress >= last, 'progress never moves backwards');
    last = job.progress;
    seen.add(job.step);
  }
  assert.deepEqual([...seen], ['prepare_wait', 'run_wait', 'report_wait', 'done']);

  const start = fake.state.requests[0];
  assert.equal(start.method, 'POST');
  assert.equal(start.path, '/v1/predictions');
  assert.equal(start.auth, `Bearer ${KEY}`);
  assert.deepEqual(Object.keys(start.body).sort(), ['agents', 'context', 'question', 'rounds', 'source', 'user']);
  assert.equal(start.body.rounds, 4);
  assert.equal(start.body.question, 'How will buyers react?');

  assert.equal(job.status, 'completed');
  assert.equal(job.progress, 100);
  assert.equal(job.message, 'Forecast complete');
  assert.match(job.report, /^# Early adopters buy/);
  assert.match(job.report, /\*\*62% likely\*\* that the wearable sells out in March · medium confidence · 16 agents over 4 rounds/);
  assert.match(job.report, /## Drivers\n- price point\n- EU availability/);
  assert.match(job.report, /## Signals to watch\n- pre-order counts/);
  assert.equal(job.stats.rounds, 4);
  assert.equal(job.stats.actions, 48, '4 rounds x 12 actions');
  assert.ok(!JSON.stringify(job).includes(KEY), 'the product key never reaches the browser');
});

test('chat interviews the most influential persona (or the one asked for)', async () => {
  useProductApi();
  const job = await runToEnd((await post({ action: 'create', question: 'How will buyers react?', seed: SEED })).data.job);
  const chat = await post({ action: 'chat', job, message: 'Who drove it?' });
  assert.equal(chat.status, 200);
  assert.match(chat.data.reply, /^\*\*Acme spokesperson\*\* \(competitor\), simulated persona:\n\nAs a2: price is the sticking point\.$/);
  const full = fake.state.requests.find((r) => r.search === '?full=1');
  assert.ok(full, 'personas come from the full view');
  const p = fake.state.predictions.get(job.ids.prediction_id);
  assert.deepEqual(p.interviews.at(-1), { agentId: 'a2', question: 'Who drove it?' });

  const asked = await post({ action: 'chat', job, message: 'And you?', agentId: 'a1' });
  assert.match(asked.data.reply, /^\*\*Mia Chen\*\*/);

  const running = { ...job, status: 'running', step: 'run_wait' };
  assert.equal((await post({ action: 'chat', job: running, message: 'x' })).status, 400);
});

test('stop cancels the prediction on Conjure', async () => {
  useProductApi();
  let job = (await post({ action: 'create', question: 'How will buyers react?', seed: SEED })).data.job;
  job = (await post({ action: 'advance', job })).data.job;
  const stopped = await post({ action: 'stop', job });
  assert.equal(stopped.data.job.status, 'stopped');
  assert.equal(fake.state.predictions.get(job.ids.prediction_id).cancelled, true);
  assert.ok(fake.state.requests.some((r) => r.path.endsWith('/cancel')));
});

test('failures: a refused start fails at once, polling retries transient errors, Conjure failures surface', async () => {
  useProductApi();
  const fresh = () => createApiJob({ question: 'How will buyers react?', seed: SEED }).job;

  fake.state.failStart = { status: 429, error: 'daily limit of 500 forecasts reached for scalvs' };
  let job = (await post({ action: 'advance', job: fresh() })).data.job;
  assert.equal(job.status, 'failed');
  assert.match(job.error, /daily forecast limit/);
  fake.state.failStart = null;

  job = (await post({ action: 'advance', job: fresh() })).data.job;
  fake.state.failGets = 2;
  job = (await post({ action: 'advance', job })).data.job;
  assert.equal(job.status, 'running');
  assert.match(job.message, /Retrying/);
  assert.equal(job.failures, 1);
  job = await runToEnd(job);
  assert.equal(job.status, 'completed', 'recovers after transient 503s');

  fake.state.outcome = 'failed';
  job = await runToEnd((await post({ action: 'create', question: 'How will buyers react?', seed: SEED })).data.job);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /model unavailable/);

  process.env.CONJURE_PRODUCT_KEY = 'cjp_scalvs_wrong';
  job = (await post({ action: 'advance', job: fresh() })).data.job;
  assert.equal(job.status, 'failed');
  assert.match(job.error, /product key was refused/);
});

test('tampered jobs are rejected before any request reaches Conjure', async () => {
  useProductApi();
  const job = createApiJob({ question: 'How will buyers react?', seed: SEED }).job;
  const bad = [
    { ...job, step: 'drop_tables' },
    { ...job, step: 'run_wait', ids: { prediction_id: '../admin' } },
    { ...job, step: 'run_wait', ids: {} },
    { ...job, engine: 'conjure-local' },
    { ...job, seed: '' },
    null,
  ];
  for (const j of bad) assert.equal((await post({ action: 'advance', job: j })).status, 400);
  assert.equal(fake.state.requests.length, 0);
});

test('only CONJURE_TOKEN set: the MiroFish engine path is still used', async () => {
  process.env.CONJURE_URL = baseUrl;
  process.env.CONJURE_TOKEN = 'mirofish-gateway-token';
  delete process.env.CONJURE_PRODUCT_KEY;
  const { data } = await post({ action: 'create', question: 'How will buyers react?', seed: SEED });
  assert.equal(data.job.engine, undefined);
  assert.equal(data.job.step, 'ontology');
  await post({ action: 'advance', job: data.job });
  const r = fake.state.requests.at(-1);
  assert.equal(r.path, '/api/graph/ontology/generate', 'MiroFish multi-step job, not /v1');
  assert.equal(r.auth, 'Bearer mirofish-gateway-token');
});

test('the browser orchestrator drives a product-API forecast to a report', async () => {
  useProductApi();
  store.reset();
  forecaster.setPollInterval(5);
  const realFetch = globalThis.fetch;
  // Route the browser's relative api/forecast calls into the handler; upstream calls go out for real.
  globalThis.fetch = (url, init) => (String(url).startsWith('api/forecast')
    ? (init?.method === 'POST' ? api.POST(new Request('http://localhost/api/forecast', init)) : api.GET())
    : realFetch(url, init));
  try {
    await forecaster.checkForecastLive();
    const { forecast, error } = await forecaster.startForecast({ question: 'How will buyers react?', seed: SEED, rounds: 10, platform: 'parallel', product: 'SCALVS.ai' });
    assert.equal(error, undefined);
    assert.equal(forecast.mode, 'live');
    const find = () => store.getState().forecasts.find((f) => f.id === forecast.id);
    for (let i = 0; i < 400 && find().job.status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    const done = find().job;
    assert.equal(done.status, 'completed');
    assert.equal(forecaster.stageIndex(done.step), forecaster.STAGES.length - 1);
    assert.match(done.report, /62% likely/);
    const r = await forecaster.askReportAgent(forecast.id, 'Why?');
    assert.equal(r.error, undefined);
    assert.match(find().chat.at(-1).content, /simulated persona/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('reportMarkdown tolerates sparse reports', () => {
  const md = reportMarkdown({ report: { outcome: 'Yes', probability: 2 }, agents: 4, rounds: 1 });
  assert.match(md, /\*\*100% likely\*\* that it happens/);
  assert.ok(!md.includes('## Drivers'));
  assert.equal(typeof apiClient({ url: baseUrl, key: KEY }).getFull, 'function');
});
