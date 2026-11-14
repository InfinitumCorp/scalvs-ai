// Web crawler for SCALVS Search (Perplexity-style answers) and DeepSearch.
//
//   search results -> fetch pages in parallel -> keep the main content ->
//   rank passages against the question -> (Pro) follow the best links one hop
//
// Polite by design: it identifies itself (CRAWLER_UA), obeys robots.txt
// (RFC 9309, agent token "scalvs-search", falling back to "*"), only fetches
// public https pages (checkUrl), caps each page's size and the whole crawl's
// time, and caches extracted pages so repeat questions don't refetch.
// Page text is data for the model, never instructions.

import { checkUrl } from './_vault.js';

export const CRAWLER_UA = 'Mozilla/5.0 (compatible; SCALVS-Search/1.0; +https://scalvs.app/#/search)';
export const ROBOTS_AGENT = 'scalvs-search';
const MAX_BYTES = 450_000;       // HTML read per page (the rest is cut off; keeps CPU low)
const MAX_TEXT = 60_000;         // extracted text kept per page
const CACHE_SECONDS = 6 * 3600;  // extracted pages, per Cloudflare colo
const ROBOTS_TTL_MS = 3600_000;

// ---------------------------------------------------------------- text helpers

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•',
};
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const squash = (s) => s.replace(/\s+/g, ' ').trim();
// Strip tags, decode, then strip again: escaped markup (&lt;a href…&gt;) decodes into tags.
const TAG = /<\/?[a-z][a-z0-9-]*(?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*\s*\/?>?/gi;
const textOf = (html) => squash(decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(TAG, ' '));

const STOP = new Set(('a an and are as at be but by can could did do does for from had has have how i if in into is it its '
  + 'me my no not of on or our so than that the their them then there these they this to too was we were what when where '
  + 'which who whom why will with would you your about after all also any been before being between both each few more '
  + 'most other over same should some such only own very just now out up down off again further once here s t don').split(' '));

export function terms(text) {
  return String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w));
}

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|ref_src)/i.test(k)) u.searchParams.delete(k);
    return u.toString().replace(/\/$/, '');
  } catch { return url; }
}
export const siteOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

// ---------------------------------------------------------------- extraction

function metaTags(html) {
  const out = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
    const name = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (name && attrs.content != null && !(name in out)) out[name] = squash(decodeEntities(attrs.content));
  }
  return out;
}

const DROP = /<(script|style|noscript|svg|template|iframe|object|form|nav|footer|header|aside|button|select|textarea|dialog|menu)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK = /<\/?(p|div|section|article|main|li|h[1-6]|br|hr|tr|td|th|blockquote|pre|dd|dt|table|ul|ol|figure|figcaption|summary|details)\b[^>]*>/gi;

function longest(html, tag) {
  let best = '';
  for (const m of html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))) {
    if (m[1].length > best.length) best = m[1];
  }
  return best;
}

// HTML -> { title, description, site, published, paragraphs[], links[] }
export function extract(html, url) {
  html = String(html).slice(0, MAX_BYTES).replace(/<!--[\s\S]*?-->/g, ' ');
  const meta = metaTags(html.slice(0, 60_000));
  const titleTag = textOf((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const body = html.replace(DROP, ' ');
  // Main content: the longest <article>, else <main>, else <body>, else everything.
  const article = longest(body, 'article');
  const mainEl = article.length > 1500 ? article : (longest(body, 'main') || (body.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [])[1] || body);
  const content = mainEl.length > 400 ? mainEl : body;

  const links = [];
  for (const m of content.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= 150) break;
    try {
      const href = new URL(decodeEntities(m[1]), url);
      const text = textOf(m[2]);
      if (href.protocol === 'https:' && text.length >= 4) links.push({ url: href.toString(), text: text.slice(0, 160) });
    } catch { /* bad href */ }
  }

  const paragraphs = [];
  let total = 0;
  let last = '';
  for (const raw of content.replace(BLOCK, '\n').split('\n')) {
    const line = textOf(raw);
    if (line.length < 30 || line === last) continue;
    paragraphs.push(line);
    last = line;
    total += line.length;
    if (total > MAX_TEXT) break;
  }
  const h1 = textOf((content.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
  return {
    title: (meta['og:title'] || titleTag || h1 || siteOf(url)).slice(0, 300),
    description: (meta['og:description'] || meta.description || '').slice(0, 500),
    site: (meta['og:site_name'] || siteOf(url)).slice(0, 80),
    published: meta['article:published_time'] || meta['datepublished'] || meta['date'] || (html.match(/<time\b[^>]*datetime=["']([^"']+)/i) || [])[1] || '',
    paragraphs,
    links,
  };
}

function extractText(text, url) {
  const paragraphs = String(text).slice(0, MAX_TEXT).split(/\n\s*\n/).map(squash).filter((p) => p.length >= 30);
  return { title: siteOf(url), description: '', site: siteOf(url), published: '', paragraphs, links: [] };
}

// ---------------------------------------------------------------- passage ranking (BM25)

// Groups paragraphs into ~400-900 character passages, scores them against the
// query terms with BM25, and returns the best ones in reading order.
export function rankPassages(paragraphs, queryTerms, maxChars = 1600) {
  const passages = [];
  let cur = '';
  for (const p of paragraphs) {
    cur = cur ? `${cur} ${p}` : p;
    if (cur.length >= 400) { passages.push(cur.slice(0, 1200)); cur = ''; }
  }
  if (cur) passages.push(cur);
  if (!passages.length) return { excerpt: '', score: 0 };

  const q = [...new Set(queryTerms)];
  const docs = passages.map((p) => terms(p));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = Object.fromEntries(q.map((t) => [t, docs.filter((d) => d.includes(t)).length]));
  const N = docs.length;
  const scored = docs.map((d, i) => {
    const tf = {};
    for (const w of d) if (w in df) tf[w] = (tf[w] || 0) + 1;
    let s = 0;
    for (const t of q) {
      if (!tf[t]) continue;
      const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
      s += idf * ((tf[t] * 2.2) / (tf[t] + 1.2 * (0.25 + 0.75 * (d.length / avg))));
    }
    return { i, s: s + (i === 0 ? 0.2 : 0) }; // a page's lead usually summarises it
  });
  const picked = [];
  let used = 0;
  for (const { i } of [...scored].sort((a, b) => b.s - a.s)) {
    if (used + passages[i].length > maxChars && picked.length) break;
    picked.push(i);
    used += passages[i].length;
  }
  picked.sort((a, b) => a - b);
  return {
    excerpt: picked.map((i) => passages[i]).join('\n').slice(0, maxChars),
    score: Math.max(...scored.map((x) => x.s)),
  };
}

// ---------------------------------------------------------------- robots.txt

export function parseRobots(txt, agent = ROBOTS_AGENT) {
  const groups = [];
  let g = null;
  let lastWasAgent = false;
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!lastWasAgent) { g = { agents: [], rules: [] }; groups.push(g); }
      g.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (g && (field === 'allow' || field === 'disallow')) g.rules.push({ allow: field === 'allow', path: value });
    }
  }
  const mine = groups.filter((x) => x.agents.some((a) => a !== '*' && agent.startsWith(a)));
  const chosen = mine.length ? mine : groups.filter((x) => x.agents.includes('*'));
  return chosen.flatMap((x) => x.rules).filter((r) => r.path);
}

export function robotsAllows(rules, pathAndQuery) {
  let best = null;
  for (const r of rules) {
    const src = r.path.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const re = new RegExp(`^${src.endsWith('$') ? src : `${src}`}`);
    if (!re.test(pathAndQuery)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

const robotsMem = new Map();
async function robotsRules(origin) {
  const hit = robotsMem.get(origin);
  if (hit && Date.now() - hit.at < ROBOTS_TTL_MS) return hit.rules;
  let rules;
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: { 'user-agent': CRAWLER_UA }, redirect: 'follow', signal: AbortSignal.timeout(2500) });
    if (res.ok) rules = parseRobots((await res.text()).slice(0, 500_000));
    else if (res.status >= 500) rules = [{ allow: false, path: '/' }]; // RFC 9309: unreachable means disallow
    else rules = [];                                                    // 4xx: no rules
  } catch {
    rules = []; // timeout or network error: treated like a missing file
  }
  if (robotsMem.size > 500) robotsMem.clear();
  robotsMem.set(origin, { rules, at: Date.now() });
  return rules;
}

// ---------------------------------------------------------------- fetching

const cacheKey = (url) => `https://crawl-cache.scalvs.app/v1?u=${encodeURIComponent(url)}`;
async function cached(url) {
  try {
    const res = await globalThis.caches?.default?.match(cacheKey(url));
    return res ? await res.json() : null;
  } catch { return null; }
}
function remember(url, page, waitUntil) {
  try {
    const put = globalThis.caches?.default?.put(cacheKey(url), new Response(JSON.stringify(page), {
      headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${CACHE_SECONDS}` },
    }));
    if (put && waitUntil) waitUntil(put.catch(() => {}));
  } catch { /* no cache here (Node) */ }
}

async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= MAX_BYTES) { reader.cancel().catch(() => {}); break; }
  }
  const buf = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.length, size - at)), at); at += c.length; if (at >= size) break; }
  const charset = (res.headers.get('content-type') || '').match(/charset=["']?([\w-]+)/i)?.[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(buf); } catch { return new TextDecoder().decode(buf); }
}

// Wikipedia articles come as plain text from its API: the polite route, and far
// cheaper than parsing a 1-2 MB article page.
async function wikipediaPage(u, timeoutMs) {
  const lang = u.hostname.split('.')[0];
  const title = decodeURIComponent(u.pathname.slice('/wiki/'.length));
  const api = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(title)}`;
  const res = await fetch(api, { headers: { 'user-agent': CRAWLER_UA, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const page = (await res.json())?.query?.pages?.[0];
  if (!page?.extract) throw new Error('no article');
  const paragraphs = page.extract.slice(0, MAX_TEXT).split('\n').map(squash).filter((p) => p.length >= 30);
  return { url: u.toString(), title: page.title, description: '', site: 'Wikipedia', published: '', paragraphs, links: [] };
}
const isWikipediaArticle = (u) => /^[a-z-]+\.wikipedia\.org$/.test(u.hostname) && u.pathname.startsWith('/wiki/') && !/^\/wiki\/\w+:/.test(u.pathname);

// One page -> extracted content, or { error } / { blocked: 'robots' }.
export async function fetchPage(url, env, { timeoutMs = 6000, waitUntil } = {}) {
  let u;
  try { u = checkUrl(url, env); } catch (err) { return { url, error: err.message }; }
  const hit = await cached(u.toString());
  if (hit) return { ...hit, cached: true };
  if (isWikipediaArticle(u)) {
    try {
      const page = await wikipediaPage(u, timeoutMs);
      remember(u.toString(), page, waitUntil);
      return page;
    } catch { /* fall through to the page itself */ }
  }
  const rules = await robotsRules(u.origin);
  if (!robotsAllows(rules, u.pathname + u.search)) return { url: u.toString(), blocked: 'robots' };
  try {
    const res = await fetch(u.toString(), {
      headers: { 'user-agent': CRAWLER_UA, accept: 'text/html,application/xhtml+xml,text/plain;q=0.8', 'accept-language': 'en;q=0.9,*;q=0.5' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const finalUrl = res.url || u.toString();
    checkUrl(finalUrl, env); // a redirect must not leave the public web either
    if (!res.ok) { res.body?.cancel().catch(() => {}); return { url: finalUrl, error: `HTTP ${res.status}` }; }
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const isHtml = /html|xml/.test(type) || !type;
    if (!isHtml && !type.startsWith('text/plain')) { res.body?.cancel().catch(() => {}); return { url: finalUrl, error: `unsupported ${type.split(';')[0]}` }; }
    const raw = await readCapped(res);
    const page = { url: finalUrl, ...(isHtml ? extract(raw, finalUrl) : extractText(raw, finalUrl)) };
    remember(u.toString(), page, waitUntil);
    return page;
  } catch (err) {
    return { url: u.toString(), error: err?.name === 'TimeoutError' ? 'timed out' : (err?.message || 'failed') };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---------------------------------------------------------------- the crawl

export const DEPTHS = {
  quick: { perQuery: 8, pages: 6, follow: 0, excerpt: 1600, sources: 6, budgetMs: 10_000 },
  pro: { perQuery: 8, pages: 9, follow: 3, excerpt: 2200, sources: 10, budgetMs: 20_000 },
};

// search(query, limit, env) -> [{ title, url, snippet }]  (see grok.js searchWeb)
// Returns sources best-first: { title, url, site, snippet, excerpt, published, read, via }.
export async function crawl({ env, question, queries, depth = 'quick', search, onStatus = () => {}, waitUntil }) {
  const cfg = DEPTHS[depth] || DEPTHS.quick;
  const qs = [...new Set((queries?.length ? queries : [question]).map((q) => String(q).trim()).filter(Boolean))].slice(0, 4);
  const deadline = Date.now() + cfg.budgetMs;
  const left = () => Math.max(1500, Math.min(6000, deadline - Date.now()));
  const qTerms = terms([question, ...qs].join(' '));

  onStatus({ stage: 'searching', queries: qs });
  const lists = await Promise.all(qs.map((q) => search(q.slice(0, 300), cfg.perQuery, env).catch(() => [])));
  const seen = new Set();
  const hits = [];
  for (let i = 0; i < cfg.perQuery; i++) {
    for (const list of lists) {
      const h = list[i];
      if (!h?.url) continue;
      const k = normalizeUrl(h.url);
      if (seen.has(k)) continue;
      seen.add(k);
      hits.push({ ...h, rank: hits.length, via: 'search' });
    }
  }
  if (!hits.length) return [];

  const toRead = hits.slice(0, cfg.pages);
  onStatus({ stage: 'reading', count: toRead.length, sites: toRead.map((h) => siteOf(h.url)) });
  const pages = await mapLimit(toRead, 6, (h) => fetchPage(h.url, env, { timeoutMs: left(), waitUntil }));
  const results = toRead.map((h, i) => ({ hit: h, page: pages[i] }));

  // Pro: follow the links whose anchor text and path best match the question, one hop.
  if (cfg.follow && Date.now() < deadline - 3000) {
    const candidates = [];
    for (const { page } of results) {
      for (const link of page?.links || []) {
        const k = normalizeUrl(link.url);
        if (seen.has(k)) continue;
        const words = new Set(terms(`${link.text} ${new URL(link.url).pathname.replace(/[-_/]/g, ' ')}`));
        const score = qTerms.filter((t) => words.has(t)).length;
        if (score >= 2) candidates.push({ url: link.url, title: link.text, snippet: '', score, k });
      }
    }
    const follow = [];
    for (const c of candidates.sort((a, b) => b.score - a.score)) {
      if (follow.length >= cfg.follow) break;
      if (seen.has(c.k)) continue;
      seen.add(c.k);
      follow.push({ ...c, rank: hits.length + follow.length, via: 'link' });
    }
    if (follow.length) {
      onStatus({ stage: 'following', count: follow.length, sites: follow.map((h) => siteOf(h.url)) });
      const more = await mapLimit(follow, 3, (h) => fetchPage(h.url, env, { timeoutMs: left(), waitUntil }));
      follow.forEach((h, i) => results.push({ hit: h, page: more[i] }));
    }
  }

  const unique = [...new Set(qTerms)];
  const sources = results.map(({ hit, page }) => {
    const read = Boolean(page?.paragraphs?.length);
    const ranked = read ? rankPassages(page.paragraphs, qTerms, cfg.excerpt) : { excerpt: '', score: 0 };
    const snippet = hit.snippet || page?.description || '';
    const title = (read && page.title) || hit.title || siteOf(hit.url);
    const excerpt = ranked.excerpt || snippet;
    // How much of the question this page covers matters more than one word repeated.
    const words = new Set(terms(`${title} ${excerpt}`));
    const coverage = unique.length ? unique.filter((t) => words.has(t)).length / unique.length : 0;
    return {
      title,
      url: (read && page.url) || hit.url,
      site: (read && page.site) || siteOf(hit.url),
      snippet: snippet.slice(0, 300),
      excerpt,
      published: read ? page.published : '',
      read,
      via: hit.via,
      coverage,
      score: coverage * 4 + Math.min(ranked.score, 10) * 0.2 + Math.max(0, 1 - hit.rank * 0.1) - (hit.via === 'link' ? 0.3 : 0),
    };
  }).filter((s) => s.excerpt);

  // Pages actually read come first, best-scoring first; search snippets fill in after.
  sources.sort((a, b) => (b.read - a.read) || (b.score - a.score));
  const seenUrl = new Set();
  const deduped = sources.filter((s) => { const k = normalizeUrl(s.url); if (seenUrl.has(k)) return false; seenUrl.add(k); return true; });
  // Drop barely-related pages when there are enough good ones.
  const relevant = deduped.filter((s) => s.coverage >= 0.3);
  return (relevant.length >= 3 ? relevant : deduped)
    .slice(0, cfg.sources)
    .map(({ score, coverage, ...s }) => s);
}
