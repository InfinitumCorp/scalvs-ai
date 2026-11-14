// SCALVS Search on VEIL Search, Infinitum's own engine (VEIL_SEARCH_URL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchEngine, searchWeb } from '../api/grok.js';

test('VEIL_SEARCH_URL (https only) makes VEIL the engine', () => {
  assert.equal(searchEngine({ VEIL_SEARCH_URL: 'https://infinitumveil.app/api/search', BRAVE_SEARCH_API_KEY: 'k' }), 'veil');
  assert.equal(searchEngine({ VEIL_SEARCH_URL: 'http://infinitumveil.app/api/search', BRAVE_SEARCH_API_KEY: 'k' }), 'brave');
});

test('searchWeb POSTs the query to VEIL and keeps https results', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push({ url: String(url), method: init?.method, body: init?.body });
    return Response.json({ results: [
      { title: '<b>One</b>', url: 'https://a.example/1', snippet: 'first' },
      { title: 'Two', url: 'https://b.example/2', snippet: 'second' },
      { title: 'Three', url: 'https://c.example/3', snippet: 'third' },
      { title: 'Plain http', url: 'http://d.example/4', snippet: 'dropped' },
    ] });
  });
  const hits = await searchWeb('open models', 6, { VEIL_SEARCH_URL: 'https://infinitumveil.app/api/search' });
  assert.deepEqual(hits.map((h) => h.url), ['https://a.example/1', 'https://b.example/2', 'https://c.example/3']);
  assert.equal(hits[0].title, 'One');
  assert.deepEqual(seen, [{ url: 'https://infinitumveil.app/api/search', method: 'POST', body: JSON.stringify({ q: 'open models' }) }]);
});
