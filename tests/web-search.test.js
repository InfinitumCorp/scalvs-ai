import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebSearchHandler } from '../api/web-search.js';
import { createSearch } from '../api/search/search.mjs';
import { mentionIn } from '../src/mentions.js';

const verify = async (token) => (token === 'cid-token-ada' ? 'cid_ada' : null);
const pages = async (url) =>
  url.endsWith('/robots.txt')
    ? new Response('', { status: 404 })
    : new Response(`<title>Launch</title><article>${'The launch is on Tuesday. '.repeat(20)}</article>`, { headers: { 'content-type': 'text/html' } });
const search = createSearch({
  engines: [{ name: 'test', search: async () => [{ title: 'Launch notes', url: 'https://news.example/launch', snippet: 'Tuesday' }] }],
  fetch: pages,
  chat: async () => 'It launches on Tuesday [1].',
});
const post = (body, token = 'cid-token-ada') => new Request('https://scalvs.app/api/search', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

test('the composer routes @search, with @conjure and @scalvs first', () => {
  assert.equal(mentionIn('@search when is the launch?'), 'search');
  assert.equal(mentionIn('＠Search погода'), 'search');
  assert.equal(mentionIn('mail ops@search.app'), null);
  assert.equal(mentionIn('@searchbot hi'), null);
  assert.equal(mentionIn('@scalvs @search x'), 'scalvs');
  assert.equal(mentionIn('@search @conjure x'), 'conjure');
});

test('@search needs a Cumulus ID and answers with sources', async () => {
  const handle = createWebSearchHandler({ env: {}, verify, search });
  assert.equal((await handle(post({ text: '@search when?' }, null))).status, 401);
  assert.equal((await handle(post({ text: '@search when?' }, 'bad'))).status, 401);
  const r = await (await handle(post({ text: '@search when is the launch?' }))).json();
  assert.equal(r.mention, true);
  assert.equal(r.answer, 'It launches on Tuesday [1].');
  assert.equal(r.sources[0].url, 'https://news.example/launch');
});

test('@search is off until a search engine is configured', async () => {
  const handle = createWebSearchHandler({ env: {}, verify });
  const get = await (await handle(new Request('https://scalvs.app/api/search', { headers: { authorization: 'Bearer cid-token-ada' } }))).json();
  assert.deepEqual(get, { connected: false, engines: [], answers: false });
  assert.equal((await handle(post({ query: 'x' }))).status, 503);
});
