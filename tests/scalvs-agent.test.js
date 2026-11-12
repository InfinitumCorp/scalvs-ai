import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScalvsAgentHandler, createCidVerifier, gatewayEnv } from '../api/scalvs-agent.js';
import { mentionIn, conjureQuestion } from '../src/mentions.js';

const ENV = { OPENCLAW_GATEWAY_URL: 'https://claw.test', OPENCLAW_GATEWAY_TOKEN: 'tok_secret', OPENCLAW_AGENT: 'openclaw/scalvs' };
const verify = async (token) => (token === 'cid-token-ada' ? 'cid_ada' : null);
const sent = [];
const gateway = async (_url, init) => {
  sent.push(JSON.parse(String(init.body)));
  return new Response(JSON.stringify({ choices: [{ message: { content: 'Three leads drafted.' } }] }));
};
const post = (text, token = 'cid-token-ada') => new Request('https://scalvs.app/api/openclaw', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ text }),
});

test('the composer routes @conjure, @scalvs and @scalus, not @openclaw', () => {
  assert.equal(mentionIn('@conjure will the launch slip?'), 'conjure');
  assert.equal(mentionIn('@scalvs draft three leads'), 'scalvs');
  assert.equal(mentionIn('please @Scalus summarise'), 'scalvs');
  assert.equal(mentionIn('＠scalvs go'), 'scalvs');
  assert.equal(mentionIn('@openclaw draft'), null);
  assert.equal(mentionIn('mail ops@scalvs.app'), null);
  assert.equal(mentionIn('plain task'), null);
  assert.equal(mentionIn('@scalvs ask @conjure'), 'conjure');
  assert.equal(conjureQuestion('@conjure: will the launch slip?'), 'will the launch slip?');
  assert.equal(conjureQuestion('Will we ship by March? @conjure'), 'Will we ship by March?');
});

test('a signed-in @scalvs task reaches the SCALVS agent as that person', async () => {
  const handle = createScalvsAgentHandler({ env: ENV, verify, fetch: gateway });
  const res = await handle(post('@scalvs draft three leads'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { mention: true, text: 'Three leads drafted.', agent: 'openclaw/scalvs' });
  assert.equal(sent.at(-1).user, 'scalvs:cid_ada');
  assert.equal(sent.at(-1).model, 'openclaw/scalvs');
  assert.equal(sent.at(-1).messages.at(-1).content, 'draft three leads');
  assert.ok(!JSON.stringify(body).includes('tok_secret'));
});

test('needs a valid Cumulus ID token', async () => {
  const handle = createScalvsAgentHandler({ env: ENV, verify, fetch: gateway });
  assert.equal((await handle(post('@scalvs go', null))).status, 401);
  assert.equal((await handle(post('@scalvs go', 'forged'))).status, 401);
});

test('status says connected without the URL or token', async () => {
  const handle = createScalvsAgentHandler({ env: ENV, verify, fetch: gateway });
  const text = await (await handle(new Request('https://scalvs.app/api/openclaw', { headers: { authorization: 'Bearer cid-token-ada' } }))).text();
  assert.deepEqual(JSON.parse(text), { connected: true, agent: 'openclaw/scalvs' });
  assert.ok(!text.includes('tok_secret') && !text.includes('claw.test'));
});

test('is off until configured and says how to connect', async () => {
  const handle = createScalvsAgentHandler({ env: {}, verify });
  const res = await handle(post('@scalvs go'));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /OPENCLAW_GATEWAY_URL/);
});

const ISSUER = 'https://id.cumuluscloud.app/realms/cumulus';
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
async function issuer() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', use: 'sig', alg: 'ES256' };
  const sign = async (over = {}, header = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: ISSUER, aud: 'scalvs', sub: 'cid_7c1e', client_id: 'scalvs', sid: 's1', iat: now, exp: now + 600, ...over };
    const h = b64url(JSON.stringify({ alg: 'ES256', typ: 'at+jwt', kid: 'k1', ...header }));
    const p = b64url(JSON.stringify(claims));
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
  };
  return { jwk, sign };
}

test('the Cumulus://ID verifier checks the token against the JWKS, then userinfo, and caches', async () => {
  const { jwk, sign } = await issuer();
  const calls = [];
  const v = createCidVerifier({
    fetch: async (url, init) => {
      calls.push(url);
      if (url === `${ISSUER}/protocol/openid-connect/certs`) return new Response(JSON.stringify({ keys: [jwk] }));
      assert.equal(url, `${ISSUER}/protocol/openid-connect/userinfo`);
      return init.headers.authorization.startsWith('Bearer ey') ? new Response(JSON.stringify({ sub: 'cid_7c1e', cid: 'cid_7c1e' })) : new Response('{}', { status: 401 });
    },
  });
  const good = await sign();
  assert.equal(await v(good), 'cid_7c1e');
  assert.equal(await v(good), 'cid_7c1e');
  assert.deepEqual(calls, [`${ISSUER}/protocol/openid-connect/certs`, `${ISSUER}/protocol/openid-connect/userinfo`]);
  assert.equal(await v(''), null);
  assert.equal(await v('opaque'), null);
});

test('the Cumulus://ID verifier refuses another issuer, client, type, key, expiry or subject', async () => {
  const { jwk, sign } = await issuer();
  let userinfo = 0;
  const fetch = async (url) => {
    if (url.endsWith('/certs')) return new Response(JSON.stringify({ keys: [jwk] }));
    userinfo++;
    return new Response(JSON.stringify({ sub: 'cid_7c1e' }));
  };
  const v = createCidVerifier({ fetch });
  assert.equal(await v(await sign({ iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x' })), null);
  assert.equal(await v(await sign({ aud: 'cumulus-cloud' })), null);
  assert.equal(await v(await sign({}, { typ: 'JWT' })), null);
  assert.equal(await v(await sign({ exp: Math.floor(Date.now() / 1000) - 3600 })), null);
  assert.equal(await v(await sign({ sub: 'someone' })), null);
  assert.equal(await v(await (await issuer()).sign()), null);
  const tampered = (await sign()).split('.');
  tampered[1] = b64url(JSON.stringify({ iss: ISSUER, aud: 'scalvs', sub: 'cid_other', exp: 9e9 }));
  assert.equal(await v(tampered.join('.')), null);
  assert.equal(userinfo, 0, 'nothing that fails offline checks reaches userinfo');
  const revoked = createCidVerifier({ fetch: async (url) => (url.endsWith('/certs') ? new Response(JSON.stringify({ keys: [jwk] })) : new Response('{}', { status: 401 })) });
  assert.equal(await revoked(await sign()), null);
  const other = createCidVerifier({ fetch: async (url) => new Response(JSON.stringify(url.endsWith('/certs') ? { keys: [jwk] } : { sub: 'cid_someone_else' })) });
  assert.equal(await other(await sign()), null);
});

test('also reads the OPENCLAW_URL / OPENCLAW_TOKEN pair that agent runs use', async () => {
  const urls = [];
  const fetch = async (url, init) => { urls.push(url); return gateway(url, init); };
  const handle = createScalvsAgentHandler({ env: { OPENCLAW_URL: 'https://claw.test/v1/', OPENCLAW_TOKEN: 't', OPENCLAW_AGENT: 'openclaw/default' }, verify, fetch });
  const res = await handle(post('@scalvs go'));
  assert.equal(res.status, 200);
  assert.equal(urls.at(-1), 'https://claw.test/v1/chat/completions');
  assert.equal(gatewayEnv({ OPENCLAW_GATEWAY_URL: 'https://a.test', OPENCLAW_URL: 'https://b.test/v1' }).OPENCLAW_GATEWAY_URL, 'https://a.test');
});
