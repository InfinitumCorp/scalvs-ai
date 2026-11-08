// Workers AI backend: /api/run and /api/forecast running on the Worker's AI
// binding (no provider key), with CONJURE inside the Worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as run from '../api/run.js';
import * as forecast from '../api/forecast.js';
import { LOCAL_LIMITS } from '../api/_conjure-local.js';

const SEED = 'The central bank meets on Thursday. Inflation fell to 3.1%. Banks and exporters want a cut; pensioners fear it fuels prices. Two board members hinted at patience.';

// Scripted Workers AI binding answering each CONJURE prompt type (shapes from nexus conjure.test.ts).
function fakeAI({ stream = [] } = {}) {
  const calls = [];
  const reply = (system, user) => {
    if (system.includes('map the world')) {
      return JSON.stringify({
        summary: 'A rate decision with split interests.',
        poles: { for: 'the bank cuts rates', against: 'the bank holds' },
        entities: [
          { id: 'e1', name: 'Central Bank Board', kind: 'organization', description: 'Sets rates' },
          { id: 'e2', name: "Exporters' Union", kind: 'group', description: 'Wants a cut' },
        ],
        relations: [{ from: 'e2', to: 'e1', type: 'lobbies' }],
        facts: ['Inflation 3.1%'],
      });
    }
    if (system.includes('diverse, realistic personas')) {
      const n = Number(/Create (\d+) new personas/.exec(user)[1]);
      return JSON.stringify({ personas: Array.from({ length: n }, (_, i) => ({
        name: `Agent ${i + 1}`, entityId: i % 2 ? 'e2' : 'e1', role: i % 2 ? 'exporter' : 'board member', traits: 'calm', goals: 'be heard',
        stance: i % 2 ? 0.5 : -0.3, influence: (i % 5) + 1,
      })) });
    }
    if (system.includes('play several people')) {
      const ids = [...user.matchAll(/AGENT (a\d+):/g)].map((m) => m[1]);
      return JSON.stringify({ actions: ids.map((id) => ({ agentId: id, action: 'post', text: `${id} expects a cut`, stanceShift: 0.1 })) });
    }
    if (system.includes('report analyst')) {
      return JSON.stringify({ outcome: 'The bank cuts by 25bp.', probability: 0.64, forecast: 'Exporters dominate the debate.', drivers: ['Falling inflation'], signals: ['Board speeches'], assumptions: ['No shock'], confidence: 'medium' });
    }
    return 'ok';
  };
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      if (input.stream) {
        return new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            for (const t of stream) c.enqueue(enc.encode(`data: ${JSON.stringify({ response: t })}\n\n`));
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          },
        });
      }
      const [system, user] = input.messages.map((m) => m.content);
      return { response: reply(system, user) };
    },
  };
}

const post = (handler, body, env) => handler(new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) }), env);

test('GET reports live when only the AI binding is present', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CONJURE_URL;
  delete process.env.MIROFISH_URL;
  const env = { AI: fakeAI() };
  assert.equal((await (await run.GET(null, env)).json()).live, true);
  assert.equal((await (await forecast.GET(null, env)).json()).live, true);
  assert.equal((await (await run.GET(null, {})).json()).live, false);
});

test('/api/run answers through Workers AI without a key, streaming and not', async () => {
  const ai = fakeAI({ stream: ['Hello', ' world'] });
  const env = { AI: ai };
  const once = await (await post(run.POST, { task: 'Say hi', agent: { name: 'Atlas' } }, env)).json();
  assert.equal(once.mode, 'live');
  assert.ok(ai.calls[0].input.messages[0].content.length > 0, 'system prompt sent');

  const res = await post(run.POST, { task: 'Say hi', stream: true }, env);
  assert.match(res.headers.get('content-type'), /event-stream/);
  const events = (await res.text()).trim().split('\n\n').map((l) => JSON.parse(l.slice(5)));
  assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Hello world');
  assert.equal(events.at(-1).type, 'done');
});

test('/api/run streams an error, not a success, when the model sends no text', async () => {
  const res = await post(run.POST, { task: 'x', stream: true }, { AI: fakeAI({ stream: [] }) });
  const events = (await res.text()).trim().split('\n\n').map((l) => JSON.parse(l.slice(5)));
  assert.equal(events.at(-1).type, 'error');
});

test('/api/run stays in demo mode with no key and no binding', async () => {
  const res = await post(run.POST, { task: 'x' }, {});
  assert.equal(res.status, 503);
});

test('a forecast runs end to end on the in-Worker CONJURE engine', async () => {
  const env = { AI: fakeAI() };
  let { job } = await (await post(forecast.POST, { action: 'create', question: 'Will the bank cut rates?', seed: SEED, rounds: 10 }, env)).json();
  assert.equal(job.engine, 'conjure-local');
  for (let i = 0; i < 20 && job.status === 'running'; i++) {
    // The job round-trips through JSON like it does through the browser.
    job = (await (await post(forecast.POST, { action: 'advance', job: JSON.parse(JSON.stringify(job)) }, env)).json()).job;
  }
  assert.equal(job.status, 'completed', job.error || job.message);
  assert.equal(job.progress, 100);
  assert.match(job.report, /The bank cuts by 25bp/);
  assert.match(job.report, /64%/);
  assert.ok(job.stats.actions > 0);
  assert.ok(job.sim.personas.length <= LOCAL_LIMITS.agents);

  const chat = await (await post(forecast.POST, { action: 'chat', job, message: 'Why?' }, env)).json();
  assert.equal(chat.mode, 'live');
  assert.ok(chat.reply);
});

test('the browser cannot raise the server-side caps', async () => {
  const env = { AI: fakeAI() };
  let { job } = await (await post(forecast.POST, { action: 'create', question: 'Will the bank cut rates?', seed: SEED, rounds: 40 }, env)).json();
  job = (await (await post(forecast.POST, { action: 'advance', job }, env)).json()).job;
  job.sim.rounds = 500;
  job.sim.maxCalls = 100000;
  job = (await (await post(forecast.POST, { action: 'advance', job }, env)).json()).job;
  assert.ok(job.sim.rounds <= LOCAL_LIMITS.maxRounds);
  assert.equal(job.sim.maxCalls, LOCAL_LIMITS.maxCalls);

  const huge = { ...job, sim: { ...job.sim, facts: ['x'.repeat(LOCAL_LIMITS.maxSimBytes)] } };
  const failed = (await (await post(forecast.POST, { action: 'advance', job: huge }, env)).json()).job;
  assert.equal(failed.status, 'failed');
});
