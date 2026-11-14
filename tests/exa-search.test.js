// SCALVS Search on Exa (EXA_API_KEY): startup credits, after VEIL, before Brave/Google/SearXNG.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchEngine, searchWeb } from '../api/grok.js';

const exaReply = () => Response.json({ results: [
  { title: 'A', url: 'https://a.example/1', highlights: ['first', 'hit'] },
  { title: 'B', url: 'https://b.example/2', text: 'second' },
  { title: 'C', url: 'https://c.example/3', highlights: ['third'] },
  { title: 'Plain http', url: 'http://d.example/4' },
] });

test('engine order: VEIL first, then Exa, then Brave; EXA_SEARCH=off removes Exa', () => {
  assert.equal(searchEngine({ VEIL_SEARCH_URL: 'https://infinitumveil.app/api/search', EXA_API_KEY: 'e' }), 'veil');
  assert.equal(searchEngine({ EXA_API_KEY: 'e', BRAVE_SEARCH_API_KEY: 'b' }), 'exa');
  assert.equal(searchEngine({ EXA_API_KEY: 'e', EXA_SEARCH: 'off', BRAVE_SEARCH_API_KEY: 'b' }), 'brave');
});

test('Exa: POST with x-api-key, highlights as snippets, https only', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { seen.push({ url: String(url), init }); return exaReply(); });
  const hits = await searchWeb('graph databases', 6, { EXA_API_KEY: 'ek' });
  assert.deepEqual(hits.map((h) => h.url), ['https://a.example/1', 'https://b.example/2', 'https://c.example/3']);
  assert.equal(hits[0].snippet, 'first hit');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.exa.ai/search');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers['x-api-key'], 'ek');
  assert.equal(JSON.parse(seen[0].init.body).query, 'graph databases');
});

test('VEIL down: Exa answers before the keyless fallback', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    seen.push(String(url));
    if (String(url).startsWith('https://infinitumveil.app')) return new Response('down', { status: 502 });
    return exaReply();
  });
  const hits = await searchWeb('q', 6, { VEIL_SEARCH_URL: 'https://infinitumveil.app/api/search', EXA_API_KEY: 'ek' });
  assert.equal(hits.length, 3);
  assert.deepEqual(seen, ['https://infinitumveil.app/api/search', 'https://api.exa.ai/search']);
});
