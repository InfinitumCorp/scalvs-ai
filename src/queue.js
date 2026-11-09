// Client side of the optional SQS step queue. Returns null when the queue is
// off or the step does not fit, and the caller keeps the synchronous path.

import { queueEnabled } from './remote.js';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new DOMException('Stopped', 'AbortError'));
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(new DOMException('Stopped', 'AbortError'));
  }, { once: true });
});

export async function postQueued(kind, payload, { signal } = {}) {
  if (!queueEnabled()) return null;
  const enqRes = await fetch('api/jobs', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'enqueue', kind, payload }),
  });
  if (enqRes.status === 503 || enqRes.status === 413) return null;
  const enq = await enqRes.json().catch(() => ({}));
  if (!enqRes.ok || !enq.jobId) return { res: enqRes, data: enq };
  for (let attempt = 0; attempt < 5; attempt++) {
    const tickRes = await fetch('api/jobs', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'tick', jobId: enq.jobId, claim: enq.claim }),
    });
    const data = await tickRes.json().catch(() => ({}));
    if (data.status === 'pending') {
      await sleep(200, signal);
      continue;
    }
    if (data.status === 'done') return { res: new Response(null, { status: 200 }), data: data.result };
    return { res: tickRes, data: { error: data.error || 'The queued step failed. Please retry.' } };
  }
  return { res: new Response(null, { status: 504 }), data: { error: 'The queued step did not finish. Please retry.' } };
}
