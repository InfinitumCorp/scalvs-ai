// Optional SQS queue for one agent step or one forecast step.
// Off unless AWS_REGION, credentials, and AWS_SQS_QUEUE_URL are set.
// The synchronous /api/run and /api/forecast handlers stay the default.

import { POST as runPost } from './run.js';
import { POST as forecastPost } from './forecast.js';
import { MAX_QUEUE_BYTES, emitMetric, sqsDelete, sqsEnabled, sqsReceive, sqsRelease, sqsSend } from './_aws.js';

const encoder = new TextEncoder();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  return Boolean(origin) && origin === new URL(request.url).origin;
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function GET() {
  return json({ ok: true, enabled: sqsEnabled() });
}

export async function POST(request, env) {
  if (!sqsEnabled()) return json({ enabled: false, error: 'The job queue is not configured' }, 503);
  if (!sameOrigin(request)) return json({ error: 'Cross-origin request refused' }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  if (body?.action === 'enqueue') return enqueue(body);
  if (body?.action === 'tick') return tick(body, env);
  return json({ error: 'Unknown action' }, 400);
}

async function enqueue(body) {
  if (body.kind !== 'run' && body.kind !== 'forecast') return json({ error: 'Unknown job kind' }, 400);
  if (!body.payload || typeof body.payload !== 'object') return json({ error: 'Missing payload' }, 400);
  const envelope = {
    v: 1,
    jobId: randomId(),
    claim: randomId(),
    kind: body.kind,
    payload: body.kind === 'run' ? { ...body.payload, stream: false } : body.payload,
  };
  const encoded = JSON.stringify(envelope);
  if (encoder.encode(encoded).byteLength > MAX_QUEUE_BYTES) {
    return json({ error: 'This step is too large for the queue.', fallback: true }, 413);
  }
  try {
    const sent = await sqsSend(encoded);
    return json({ enabled: true, queued: true, jobId: envelope.jobId, claim: envelope.claim, messageId: sent.MessageId || null });
  } catch {
    emitMetric('QueueFailures');
    return json({ error: 'The job could not be queued. Please retry.' }, 502);
  }
}

async function tick(body, env) {
  const jobId = String(body?.jobId || '');
  const claim = String(body?.claim || '');
  if (!/^[a-f0-9]{32}$/.test(jobId) || !/^[a-f0-9]{32}$/.test(claim)) return json({ error: 'Missing job id' }, 400);
  let received;
  try {
    received = await sqsReceive();
  } catch {
    emitMetric('QueueFailures');
    return json({ error: 'The queue could not be read. Please retry.' }, 502);
  }
  const message = received?.Messages?.[0];
  if (!message) return json({ status: 'pending' });
  let envelope;
  try { envelope = JSON.parse(message.Body); } catch { envelope = null; }
  if (!envelope || envelope.jobId !== jobId || envelope.claim !== claim) {
    try { await sqsRelease(message.ReceiptHandle); } catch { emitMetric('QueueFailures'); }
    return json({ status: 'pending' });
  }
  const attempts = Number(message.Attributes?.ApproximateReceiveCount || 1);
  if (attempts > 3) {
    try { await sqsDelete(message.ReceiptHandle); } catch { emitMetric('QueueFailures'); }
    return json({ status: 'error', error: 'The queued step failed repeatedly. Please retry.' }, 502);
  }
  try {
    const outcome = await runPayload(envelope, env);
    try { await sqsDelete(message.ReceiptHandle); } catch { emitMetric('QueueFailures'); }
    if (!outcome.ok) return json({ status: 'error', error: outcome.error || 'The queued step failed. Please retry.' }, outcome.status || 502);
    return json({ status: 'done', result: outcome.result });
  } catch {
    emitMetric('QueueFailures');
    return json({ status: 'error', error: 'The queued step could not complete. Please retry.' }, 502);
  }
}

async function runPayload(envelope, env) {
  const handler = envelope.kind === 'forecast' ? forecastPost : runPost;
  const path = envelope.kind === 'forecast' ? '/api/forecast' : '/api/run';
  const response = await handler(new Request(`https://scalvs.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope.payload),
  }), env);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, status: response.status, error: result.error || 'The queued step failed. Please retry.' };
  return { ok: true, result };
}
