import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScalvsAgentHandler, createCidVerifier } from '../api/scalvs-agent.js';
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

test('the Cumulus ID verifier asks the issuer and caches the answer', async () => {
  let calls = 0;
  const v = createCidVerifier({
    issuer: 'https://id.test/',
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, 'https://id.test/api/id/userinfo');
      return init.headers.authorization === 'Bearer good' ? new Response(JSON.stringify({ cid: 'cid_1' })) : new Response('{}', { status: 401 });
    },
  });
  assert.equal(await v('good'), 'cid_1');
  assert.equal(await v('good'), 'cid_1');
  assert.equal(calls, 1);
  assert.equal(await v('bad'), null);
  assert.equal(await v(''), null);
});
