// End-to-end check: SCALVS.ai's agent runtime (api/run.js) against a real
// OpenClaw gateway. Needs OPENCLAW_URL (…/v1) and usually OPENCLAW_TOKEN.
//   OPENCLAW_URL=http://127.0.0.1:18789/v1 OPENCLAW_TOKEN=… node scripts/openclaw-e2e.mjs
// Exits non-zero on the first failure. Prints timings, never the token.
import { GET, POST } from '../api/run.js';

if (!process.env.OPENCLAW_URL) {
  console.error('Set OPENCLAW_URL first.');
  process.exit(2);
}

const task = (extra = {}) => new Request('https://scalvs.test/api/run', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ agent: { name: 'Scout', role: 'Researcher' }, task: 'In one short sentence, say what an agent gateway does.', ...extra }),
});

let failed = false;
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    console.log(`PASS ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)${note ? `: ${note}` : ''}`);
  } catch (err) {
    failed = true;
    console.log(`FAIL ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s): ${err.message}`);
  }
}
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const short = (s) => JSON.stringify(String(s).slice(0, 160));

await step('GET /api/run reports OpenClaw', async () => {
  const body = await (await GET(new Request('https://scalvs.test/api/run'), {})).json();
  check(body.live === true && body.engine === 'openclaw', `got ${JSON.stringify(body)}`);
});

await step('agent step, not streamed', async () => {
  const res = await POST(task({ stream: false }), {});
  const body = await res.json();
  check(res.status === 200, `status ${res.status}: ${JSON.stringify(body)}`);
  check(body.mode === 'live' && body.output?.trim(), `no output: ${JSON.stringify(body)}`);
  return `${body.model} -> ${short(body.output)}`;
});

await step('agent step, streamed', async () => {
  const res = await POST(task({ stream: true }), {});
  check(res.status === 200, `status ${res.status}: ${await res.text()}`);
  const events = (await res.text()).trim().split('\n\n').filter(Boolean).map((l) => JSON.parse(l.slice(5)));
  const types = events.map((e) => e.type);
  check(!types.includes('error'), `error event: ${JSON.stringify(events.find((e) => e.type === 'error'))}`);
  check(types.includes('text') && types.at(-1) === 'done', `events: ${types.join(',')}`);
  return short(events.filter((e) => e.type === 'text').map((e) => e.text).join(''));
});

process.exit(failed ? 1 : 0);
