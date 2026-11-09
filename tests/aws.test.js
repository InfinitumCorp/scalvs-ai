// AWS Always Free adapters stay off unless region, credentials, and the
// service's own setting are present. Enabled paths are mocked.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GET as jobsGet, POST as jobsPost } from '../api/jobs.js';
import { GET as stateGet, POST as statePost } from '../api/state.js';
import { GET as runGet, POST as runPost } from '../api/run.js';
import { metricsEnabled, metricsSettled } from '../api/_aws.js';

const originalFetch = globalThis.fetch;
const KEYS = [
  'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'AWS_SQS_QUEUE_URL', 'AWS_DYNAMODB_TABLE', 'AWS_CLOUDWATCH_NAMESPACE',
  'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const QUEUE = 'https://sqs.us-east-1.amazonaws.com/123456789012/scalvs-jobs';
const SECRET = 'test-secret-key';

globalThis.localStorage = {
  data: new Map(),
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; },
  setItem(key, value) { this.data.set(key, String(value)); },
  removeItem(key) { this.data.delete(key); },
};
const remote = await import('../src/remote.js');
const { postQueued } = await import('../src/queue.js');

afterEach(() => {
  globalThis.fetch = originalFetch;
  remote.resetServicesForTests();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function clearAws() {
  for (const key of KEYS) delete process.env[key];
}

function enableAws(extra = {}) {
  clearAws();
  process.env.AWS_REGION = 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
  process.env.AWS_SECRET_ACCESS_KEY = SECRET;
  Object.assign(process.env, extra);
}

function req(path, { method = 'GET', body, origin = 'https://scalvs.test' } = {}) {
  return new Request(`https://scalvs.test${path}`, {
    method,
    headers: {
      ...(origin ? { origin } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readCall(input, init) {
  const request = input instanceof Request ? input : new Request(input, init);
  return {
    url: request.url,
    target: request.headers.get('x-amz-target'),
    auth: request.headers.get('authorization') || '',
    body: await request.clone().text(),
  };
}

test('SQS, DynamoDB, and CloudWatch stay off without their own settings', async () => {
  clearAws();
  let called = false;
  globalThis.fetch = async () => { called = true; return Response.json({}); };
  assert.equal((await (await jobsGet()).json()).enabled, false);
  assert.equal((await jobsPost(req('/api/jobs', { method: 'POST', body: { action: 'enqueue', kind: 'run', payload: { task: 'Hi' } } }))).status, 503);
  assert.equal((await (await stateGet(req('/api/state'))).json()).enabled, false);
  assert.equal((await statePost(req('/api/state', { method: 'POST', body: { profile: 'a'.repeat(32), updatedAt: 1, state: { agents: [] } } }))).status, 503);
  const flags = await (await runGet(null, {})).json();
  assert.equal(flags.queue, false);
  assert.equal(flags.state, false);
  assert.equal(called, false);

  enableAws();
  assert.equal((await (await jobsGet()).json()).enabled, false);
  assert.equal(metricsEnabled(), false);
  enableAws({ AWS_SQS_QUEUE_URL: 'https://bedrock.us-east-1.amazonaws.com/123456789012/models' });
  assert.equal((await (await jobsGet()).json()).enabled, false);
  assert.equal(called, false);
});

test('a configured queue accepts one step and a tick runs it without Bedrock', async () => {
  enableAws({ AWS_SQS_QUEUE_URL: QUEUE });
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  let sent = '';
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const call = await readCall(input, init);
    calls.push(call);
    assert.equal(call.url.includes('bedrock'), false);
    assert.equal(call.body.includes(SECRET), false);
    assert.equal(call.url.includes(SECRET), false);
    assert.match(call.auth, /^AWS4-HMAC-SHA256/);
    if (call.target === 'AmazonSQS.SendMessage') {
      sent = JSON.parse(call.body).MessageBody;
      assert.equal(JSON.parse(call.body).QueueUrl, QUEUE);
      return Response.json({ MessageId: 'mid-1' });
    }
    if (call.target === 'AmazonSQS.ReceiveMessage') {
      const requested = JSON.parse(call.body);
      assert.equal(requested.WaitTimeSeconds, 0);
      assert.equal(requested.MaxNumberOfMessages, 1);
      return Response.json({ Messages: [{ MessageId: 'mid-1', ReceiptHandle: 'rh-1', Body: sent, Attributes: { ApproximateReceiveCount: '1' } }] });
    }
    if (call.target === 'AmazonSQS.DeleteMessage') return Response.json({});
    throw new Error(`unexpected ${call.target}`);
  };
  const env = { AI: { async run() { return { response: 'queued draft' }; } } };
  const enqueued = await jobsPost(req('/api/jobs', {
    method: 'POST',
    body: { action: 'enqueue', kind: 'run', payload: { task: 'Draft a memo', agent: { name: 'Atlas' } } },
  }));
  assert.equal(enqueued.status, 200);
  const ticket = await enqueued.json();
  assert.match(ticket.jobId, /^[a-f0-9]{32}$/);
  const done = await jobsPost(req('/api/jobs', {
    method: 'POST',
    body: { action: 'tick', jobId: ticket.jobId, claim: ticket.claim },
  }), env);
  assert.equal(done.status, 200);
  assert.equal((await done.json()).result.output, 'queued draft');
  assert.deepEqual(calls.map((call) => call.target), [
    'AmazonSQS.SendMessage',
    'AmazonSQS.ReceiveMessage',
    'AmazonSQS.DeleteMessage',
  ]);
});

test('a tick releases a message that belongs to someone else', async () => {
  enableAws({ AWS_SQS_QUEUE_URL: QUEUE });
  const targets = [];
  globalThis.fetch = async (input, init) => {
    const call = await readCall(input, init);
    targets.push(call.target);
    if (call.target === 'AmazonSQS.SendMessage') return Response.json({ MessageId: 'mid-2' });
    if (call.target === 'AmazonSQS.ReceiveMessage') {
      return Response.json({ Messages: [{ MessageId: 'other', ReceiptHandle: 'rh-other', Body: JSON.stringify({ v: 1, jobId: 'c'.repeat(32), claim: 'd'.repeat(32), kind: 'run', payload: { task: 'nope' } }), Attributes: { ApproximateReceiveCount: '1' } }] });
    }
    if (call.target === 'AmazonSQS.ChangeMessageVisibility') {
      assert.equal(JSON.parse(call.body).VisibilityTimeout, 0);
      return Response.json({});
    }
    throw new Error(`unexpected ${call.target}`);
  };
  const ticket = await (await jobsPost(req('/api/jobs', {
    method: 'POST',
    body: { action: 'enqueue', kind: 'forecast', payload: { action: 'advance', job: { step: 'ontology' } } },
  }))).json();
  const pending = await jobsPost(req('/api/jobs', { method: 'POST', body: { action: 'tick', jobId: ticket.jobId, claim: ticket.claim } }));
  assert.equal((await pending.json()).status, 'pending');
  assert.ok(targets.includes('AmazonSQS.ChangeMessageVisibility'));
  assert.equal(targets.includes('AmazonSQS.DeleteMessage'), false);
});

test('a failed queue send records QueueFailures and does not pretend the step ran', async () => {
  enableAws({ AWS_SQS_QUEUE_URL: QUEUE, AWS_CLOUDWATCH_NAMESPACE: 'SCALVS' });
  let metric = null;
  globalThis.fetch = async (input, init) => {
    const call = await readCall(input, init);
    if (call.target === 'AmazonSQS.SendMessage') return new Response('denied', { status: 500 });
    if (call.url.includes('monitoring.us-east-1.amazonaws.com')) {
      metric = JSON.parse(call.body);
      return Response.json({});
    }
    throw new Error(call.target || call.url);
  };
  const response = await jobsPost(req('/api/jobs', {
    method: 'POST',
    body: { action: 'enqueue', kind: 'run', payload: { task: 'Hi' } },
  }));
  assert.equal(response.status, 502);
  await metricsSettled();
  assert.equal(metric.MetricData[0].MetricName, 'QueueFailures');
  assert.equal(Object.hasOwn(metric.MetricData[0], 'Dimensions'), false);
});

test('CloudWatch records an agent run error without blocking or adding dimensions', async () => {
  enableAws({ AWS_CLOUDWATCH_NAMESPACE: 'SCALVS' });
  process.env.ANTHROPIC_API_KEY = 'test-anthropic';
  let metric = null;
  globalThis.fetch = async (input, init) => {
    const call = await readCall(input, init);
    if (call.url.includes('monitoring.us-east-1.amazonaws.com')) {
      metric = JSON.parse(call.body);
      throw new Error('metrics endpoint unavailable');
    }
    assert.equal(call.url.includes('bedrock'), false);
    return new Response('upstream detail', { status: 529 });
  };
  const response = await runPost(new Request('https://scalvs.test/api/run', {
    method: 'POST',
    body: JSON.stringify({ task: 'Draft a memo' }),
  }));
  assert.equal(response.status, 502);
  await metricsSettled();
  assert.equal(metric.Namespace, 'SCALVS');
  assert.equal(metric.MetricData.length, 1);
  assert.equal(metric.MetricData[0].MetricName, 'AgentRunErrors');
  assert.equal(metric.MetricData[0].Unit, 'Count');
  assert.equal(Object.hasOwn(metric.MetricData[0], 'Dimensions'), false);
  assert.equal(JSON.stringify(metric).includes('upstream detail'), false);
});

test('metrics stay off when the namespace is missing, even if a run fails', async () => {
  enableAws();
  process.env.ANTHROPIC_API_KEY = 'test-anthropic';
  const hosts = [];
  globalThis.fetch = async (input, init) => {
    const call = await readCall(input, init);
    hosts.push(new URL(call.url).hostname);
    return new Response('no', { status: 529 });
  };
  assert.equal((await runPost(new Request('https://scalvs.test/api/run', {
    method: 'POST',
    body: JSON.stringify({ task: 'Draft a memo' }),
  }))).status, 502);
  await metricsSettled();
  assert.deepEqual(hosts, ['api.anthropic.com']);
});

test('DynamoDB stores one profile under the 20 KB provisioned-write cap', async () => {
  enableAws({ AWS_DYNAMODB_TABLE: 'scalvs-state' });
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const call = await readCall(input, init);
    calls.push(call);
    assert.equal(call.url, 'https://dynamodb.us-east-1.amazonaws.com/');
    assert.equal(call.body.includes('PAY_PER_REQUEST'), false);
    assert.equal(call.body.includes('BillingMode'), false);
    if (call.target === 'DynamoDB_20120810.PutItem') return Response.json({});
    const item = JSON.parse(calls.find((entry) => entry.target === 'DynamoDB_20120810.PutItem').body).Item;
    return Response.json({ Item: item });
  };
  const profile = 'a'.repeat(32);
  const state = { agents: [{ id: 'agt_1', name: 'Atlas' }], updatedAt: 10 };
  const saved = await statePost(req('/api/state', { method: 'POST', body: { profile, updatedAt: 10, state } }));
  assert.equal(saved.status, 200);
  const loaded = await stateGet(req(`/api/state?profile=${profile}`));
  assert.equal((await loaded.json()).state.agents[0].name, 'Atlas');
  const put = JSON.parse(calls[0].body);
  assert.equal(put.TableName, 'scalvs-state');
  assert.equal(put.Item.pk.S, profile);

  calls.length = 0;
  const bulky = { agents: [], blob: 'x'.repeat(21 * 1024) };
  const refused = await statePost(req('/api/state', { method: 'POST', body: { profile, updatedAt: 11, state: bulky } }));
  assert.equal(refused.status, 413);
  assert.match(await refused.text(), /20 KB/);
  assert.equal(calls.length, 0);
});

test('the browser keeps the synchronous path unless the server enabled the queue', async () => {
  remote.resetServicesForTests();
  let called = false;
  globalThis.fetch = async () => { called = true; return Response.json({}); };
  assert.equal(await postQueued('run', { task: 'Hi' }), null);
  assert.equal(called, false);

  remote.noteServiceFlags({ queue: true });
  globalThis.fetch = async () => new Response(JSON.stringify({ enabled: false }), { status: 503 });
  assert.equal(await postQueued('run', { task: 'Hi' }), null);

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.action === 'enqueue') return Response.json({ queued: true, jobId: 'a'.repeat(32), claim: 'b'.repeat(32) });
    return Response.json({ status: 'done', result: { mode: 'live', output: 'from queue', job: { step: 'done', status: 'completed' } } });
  };
  const queued = await postQueued('run', { task: 'Hi' });
  assert.equal(queued.data.output, 'from queue');
});
