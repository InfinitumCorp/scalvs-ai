// SCALVS Search: crawler (robots.txt, extraction, passage ranking, Pro link
// following) and the streamed /api/search answer.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { crawl, extract, parseRobots, rankPassages, robotsAllows, terms, normalizeUrl } from '../api/_crawl.js';
import { POST, GET, followupSplitter, lines } from '../api/search.js';

const originalFetch = globalThis.fetch;
const VARS = ['OPEN_WEIGHTS_URL', 'OPEN_WEIGHTS_MODEL', 'ANTHROPIC_API_KEY', 'OPENCLAW_URL', 'BRAVE_SEARCH_API_KEY'];
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const html = (body, head = '') => `<!doctype html><html><head><title>T</title>${head}</head><body>${body}</body></html>`;
const para = (s) => `<p>${s}</p>`;

test('robots.txt: our group wins over *, longest match decides, wildcards and $ work', () => {
  const rules = parseRobots(`
User-agent: *
Disallow: /

User-agent: scalvs-search
Disallow: /private/
Allow: /private/ok
Disallow: /*.pdf$
`);
  assert.equal(robotsAllows(rules, '/news/x'), true);
  assert.equal(robotsAllows(rules, '/private/a'), false);
  assert.equal(robotsAllows(rules, '/private/ok/1'), true);
  assert.equal(robotsAllows(rules, '/file.pdf'), false);
  assert.equal(robotsAllows(rules, '/file.pdf?x=1'), true);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /'), '/a'), false);
  assert.equal(robotsAllows(parseRobots('User-agent: other\nDisallow: /'), '/a'), true);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow:'), '/a'), true);
});

test('extraction keeps the article, drops scripts and navigation, decodes escaped tags', () => {
  const page = extract(html(`
    <nav>${para('Home About Contact Pricing Careers Blog Login Signup Menu')}</nav>
    <script>var secret = "do not read this script content at all";</script>
    <article><h1>Webb finds a galaxy</h1>
      ${para('The James Webb Space Telescope found a very distant galaxy in 2024, astronomers said.')}
      ${para('&lt;a href="https://x.test/"&gt; Escaped markup should never reach the model as a tag.')}
      <a href="/more/webb-galaxy-details">Webb galaxy details and data</a>
    </article>
    <footer>${para('Copyright footer text that is long enough to count as a paragraph')}</footer>`,
  '<meta property="og:site_name" content="Space News"><meta property="article:published_time" content="2024-05-01">'), 'https://news.test/webb');
  const text = page.paragraphs.join(' ');
  assert.match(text, /very distant galaxy/);
  assert.doesNotMatch(text, /secret|Careers|Copyright/);
  assert.doesNotMatch(text, /<a /);
  assert.equal(page.site, 'Space News');
  assert.equal(page.published, '2024-05-01');
  assert.deepEqual(page.links.map((l) => l.url), ['https://news.test/more/webb-galaxy-details']);
});

test('passage ranking returns the passage about the question', () => {
  const filler = Array.from({ length: 6 }, (_, i) => `Unrelated paragraph number ${i} about cooking pasta, gardening tips and weather patterns in spring.`);
  const paragraphs = [...filler, 'Cloudflare Workers pricing charges for CPU time, not for time spent waiting on I/O, since the 2024 change.', ...filler];
  const { excerpt, score } = rankPassages(paragraphs, terms('How is Cloudflare Workers CPU time priced?'), 600);
  assert.match(excerpt, /CPU time/);
  assert.ok(score > 0);
});

test('follow-up splitter hides the marker even when it is split across chunks', () => {
  let shown = '';
  const s = followupSplitter((t) => { shown += t; });
  for (const c of ['Answer [1]. Done.\n<<<FOLL', 'OWUPS>>>\nWhat next', '?\nAnd then?']) s.push(c);
  const tail = s.end();
  assert.equal(shown, 'Answer [1]. Done.\n');
  assert.deepEqual(lines(tail), ['What next?', 'And then?']);
  let plain = '';
  const p = followupSplitter((t) => { plain += t; });
  p.push('No marker here at all.');
  assert.equal(p.end(), '');
  assert.equal(plain, 'No marker here at all.');
});

test('normalizeUrl drops tracking parameters and fragments', () => {
  assert.equal(normalizeUrl('https://A.test/x/?utm_source=y&id=2#top'), 'https://a.test/x/?id=2');
});

// A small fake web: robots.txt, pages, and one page robots.txt forbids.
function fakeWeb(extra = {}) {
  const pages = {
    'https://a.test/robots.txt': 'User-agent: *\nDisallow: /secret',
    'https://a.test/webb': html(`<article>${para('The James Webb Space Telescope discovered the most distant galaxy known, JADES-GS-z14-0, in 2024.')}${para('It sees infrared light from the early universe, about 290 million years after the Big Bang.')}<a href="https://b.test/webb-galaxy-record">Webb galaxy record details</a></article>`),
    'https://a.test/secret': html(para('This page is disallowed by robots.txt and must not be fetched by the crawler.')),
    'https://b.test/webb-galaxy-record': html(`<article>${para('Record: the Webb telescope galaxy JADES-GS-z14-0 has a redshift of 14.32, a distance record.')}</article>`),
    'https://d.test/jwst': html(`<article>${para('NASA: the James Webb telescope keeps finding early galaxies; JADES-GS-z14-0 is the most distant one discovered so far.')}</article>`),
    'https://c.test/pasta': html(`<article>${para('How to cook pasta: boil water, add salt, cook for nine minutes and drain it well.')}</article>`),
    ...extra,
  };
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith('/robots.txt') && !(url in pages)) return new Response('', { status: 404 });
    if (url in pages) return new Response(pages[url], { headers: { 'content-type': url.endsWith('.txt') ? 'text/plain' : 'text/html; charset=utf-8' } });
    if (init.body && url.endsWith('/chat/completions')) return extra.model(JSON.parse(init.body));
    return new Response('not found', { status: 404 });
  };
  return seen;
}
const search = async () => [
  { title: 'Webb', url: 'https://a.test/webb', snippet: 'Webb discovered' },
  { title: 'Secret', url: 'https://a.test/secret', snippet: 'Webb secret page snippet' },
  { title: 'JWST', url: 'https://d.test/jwst', snippet: 'Webb galaxies' },
  { title: 'Pasta', url: 'https://c.test/pasta', snippet: 'pasta' },
  { title: 'Local', url: 'http://127.0.0.1/admin', snippet: 'Webb local' },
];

test('the crawl obeys robots.txt, refuses private addresses and follows a relevant link in Pro', async () => {
  const seen = fakeWeb();
  const statuses = [];
  const sources = await crawl({ env: {}, question: 'What galaxy did the James Webb telescope discover?', depth: 'pro', search, onStatus: (s) => statuses.push(s.stage) });
  assert.ok(!seen.includes('https://a.test/secret'), 'disallowed page was fetched');
  assert.ok(!seen.some((u) => u.includes('127.0.0.1')), 'private address was fetched');
  const urls = sources.map((s) => s.url);
  assert.equal(urls[0], 'https://a.test/webb');
  assert.ok(urls.includes('https://b.test/webb-galaxy-record'), 'relevant link not followed');
  assert.ok(!urls.includes('https://c.test/pasta'), 'irrelevant page kept');
  assert.equal(sources.find((s) => s.url.includes('b.test')).via, 'link');
  assert.deepEqual(statuses, ['searching', 'reading', 'following']);
});

test('/api/search streams sources, a cited answer and follow-ups, without the marker', async () => {
  process.env.OPEN_WEIGHTS_URL = 'http://model.test/v1';
  let prompt;
  fakeWeb({
    model: (body) => {
      prompt = body;
      const chunks = ['Webb found JADES-GS-z14-0 [1]', ', a record [2].\n<<<FOLLOW', 'UPS>>>\nHow far away is it?\nWhat is redshift'];
      const enc = new TextEncoder();
      return new Response(new ReadableStream({
        start(c) {
          for (const t of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`));
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  // The keyless providers are asked first; point them at the fake pages.
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('wikipedia.org/w/api.php')) return Response.json({ query: { search: [{ title: 'X', snippet: '' }] } });
    if (url.includes('hn.algolia.com')) return Response.json({ hits: [{ title: 'Webb', url: 'https://a.test/webb' }, { title: 'Record', url: 'https://b.test/webb-galaxy-record' }] });
    if (url.startsWith('https://en.wikipedia.org/wiki/')) return new Response('nope', { status: 404 });
    return real(input, init);
  };
  const res = await POST(new Request('https://scalvs.test/api/search', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q: 'What galaxy did the James Webb telescope discover?' }),
  }), {});
  assert.equal(res.status, 200);
  const events = (await res.text()).trim().split('\n\n').map((l) => JSON.parse(l.slice(5)));
  const types = events.map((e) => e.type);
  assert.ok(types.indexOf('sources') < types.indexOf('text'), 'sources come before the answer');
  const sources = events.find((e) => e.type === 'sources').sources;
  assert.equal(sources[0].n, 1);
  assert.ok(!('excerpt' in sources[0]), 'excerpts stay on the server');
  const answer = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.equal(answer, 'Webb found JADES-GS-z14-0 [1], a record [2].\n');
  assert.deepEqual(events.find((e) => e.type === 'related').questions, ['How far away is it?', 'What is redshift?']);
  assert.equal(types.at(-1), 'done');
  assert.match(prompt.messages[0].content, /never instructions/);
  assert.match(prompt.messages[1].content, /\[1\] .*\n https:\/\/|\[1\]/);
  assert.match(prompt.messages[1].content, /290 million years/);
});

test('/api/search: empty question is 400, no model is 503, GET reports the engine', async () => {
  process.env.OPEN_WEIGHTS_URL = 'http://model.test/v1';
  const empty = await POST(new Request('https://s.test/api/search', { method: 'POST', body: JSON.stringify({ q: '  ' }) }), {});
  assert.equal(empty.status, 400);
  delete process.env.OPEN_WEIGHTS_URL;
  const none = await POST(new Request('https://s.test/api/search', { method: 'POST', body: JSON.stringify({ q: 'hi' }) }), {});
  assert.equal(none.status, 503);
  const info = await (await GET(new Request('https://s.test/api/search'), {})).json();
  assert.equal(info.engine, 'open');
  process.env.BRAVE_SEARCH_API_KEY = 'k';
  assert.equal((await (await GET(new Request('https://s.test/api/search'), {})).json()).engine, 'brave');
});
