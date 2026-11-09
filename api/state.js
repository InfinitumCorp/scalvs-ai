// Optional DynamoDB store for one profile's app state.
// Off unless AWS_REGION, credentials, and AWS_DYNAMODB_TABLE are set.
// The table must be Standard class with provisioned 25 RCU / 25 WCU.
// On-demand mode is not used: it is outside the Always Free allowance and bills.
// Items are capped at 20 KB so one write stays within 20 WCU.

import { MAX_STATE_BYTES, dynamoEnabled, dynamoGet, dynamoPut } from './_aws.js';

const PROFILE = /^[a-f0-9]{32}$/;
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

export async function GET(request) {
  if (!dynamoEnabled()) return json({ ok: true, enabled: false });
  const profile = new URL(request.url).searchParams.get('profile') || '';
  if (!profile) return json({ ok: true, enabled: true, state: null });
  if (!PROFILE.test(profile)) return json({ error: 'Unknown profile' }, 400);
  try {
    const data = await dynamoGet(profile);
    const item = data?.Item;
    if (!item?.state?.S) return json({ ok: true, enabled: true, state: null });
    return json({
      ok: true,
      enabled: true,
      updatedAt: Number(item.updatedAt?.N || 0),
      state: JSON.parse(item.state.S),
    });
  } catch {
    return json({ error: 'The state store could not be read. Please retry.' }, 502);
  }
}

export async function POST(request) {
  if (!dynamoEnabled()) return json({ enabled: false, error: 'The state store is not configured' }, 503);
  if (!sameOrigin(request)) return json({ error: 'Cross-origin request refused' }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const profile = String(body?.profile || '');
  if (!PROFILE.test(profile)) return json({ error: 'Unknown profile' }, 400);
  if (!body.state || typeof body.state !== 'object' || Array.isArray(body.state)) return json({ error: 'Missing state' }, 400);
  const updatedAt = Number(body.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt < 0) return json({ error: 'Missing timestamp' }, 400);
  let encoded;
  try { encoded = JSON.stringify(body.state); } catch { return json({ error: 'Missing state' }, 400); }
  if (encoder.encode(encoded).byteLength > MAX_STATE_BYTES) {
    return json({ error: 'State is over 20 KB, which would exceed the free 25 WCU write. It stays in this browser.' }, 413);
  }
  try {
    await dynamoPut(profile, encoded, updatedAt);
    return json({ ok: true, enabled: true });
  } catch {
    return json({ error: 'The state store could not be written. Please retry.' }, 502);
  }
}

export const PUT = POST;
