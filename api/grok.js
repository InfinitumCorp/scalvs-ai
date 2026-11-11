// Grok-style extras for SCALVS.ai, all on free backends (Workers AI + public web):
//   DeepSearch  web search -> read top pages -> answer with numbered citations
//   Think       a reasoning model; its <think> trace is returned separately
//   Vision      image attachments read by a multimodal model
//   Imagine     POST /api/imagine {prompt} -> {image: data URL}
//   Share       POST /api/share {title, task, steps} -> {id};  GET /api/share?id= -> snapshot

import { cfg, kv as vaultKv, randomId } from './_vault.js';
import { crawl, terms } from './_crawl.js';

export const THINK_MODEL = '@cf/qwen/qwq-32b';
export const VISION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
export const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const UA = 'Mozilla/5.0 (compatible; SCALVS-DeepSearch/1.0; +https://scalvs.app)';
const strip = (html) => html
  .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim();


// Web search providers. Configured ones are tried in order: Brave Search API
// (BRAVE_SEARCH_API_KEY, free tier), Google Programmable Search (GOOGLE_CSE_KEY +
// GOOGLE_CSE_CX, 100 free queries a day), or a self-hosted SearXNG (SEARXNG_URL,
// open-source metasearch with format=json enabled). With none of them, or when
// they return too little, the keyless public APIs answer: Wikipedia, plus Hacker
// News (Algolia), whose stories link to articles across the web. DuckDuckGo's HTML
// page is no longer used: it answers automated requests with a bot challenge.
const httpsOnly = (hits) => hits.filter((r) => /^https:\/\//.test(r.url || ''));
const getJson = async (url, init = {}) => {
  const res = await fetch(url, { ...init, headers: { 'user-agent': UA, accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

async function braveSearch(query, limit, key) {
  const data = await getJson(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, { headers: { 'x-subscription-token': key } });
  return httpsOnly((data.web?.results || []).map((r) => ({ title: strip(r.title || ''), url: r.url, snippet: strip(r.description || '') })));
}
async function googleSearch(query, limit, key, cx) {
  const data = await getJson(`https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&num=${Math.min(limit, 10)}&q=${encodeURIComponent(query)}`);
  return httpsOnly((data.items || []).map((r) => ({ title: strip(r.title || ''), url: r.link, snippet: strip(r.snippet || '') })));
}
async function searxngSearch(query, limit, base) {
  const data = await getJson(`${base.replace(/\/$/, '')}/search?format=json&q=${encodeURIComponent(query)}`);
  return httpsOnly((data.results || []).slice(0, limit).map((r) => ({ title: strip(r.title || ''), url: r.url, snippet: strip(r.content || '') })));
}
async function wikipediaSearch(query, limit) {
  const data = await getJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${limit}&srsearch=${encodeURIComponent(query)}`);
  return (data.query?.search || []).map((r) => ({ title: r.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`, snippet: strip(r.snippet || '') }));
}
// Algolia requires every word by default; optionalWords lets any keyword match, ranked.
async function hackerNewsSearch(query, limit) {
  const q = encodeURIComponent(query);
  const data = await getJson(`https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=${limit * 2}&query=${q}&optionalWords=${q}`);
  const seen = new Set();
  return httpsOnly((data.hits || []).filter((h) => h.url && !seen.has(h.url) && seen.add(h.url))
    .map((h) => ({ title: strip(h.title || ''), url: h.url, snippet: '' }))).slice(0, limit);
}

export function searchEngine(env) {
  if (cfg(env, 'BRAVE_SEARCH_API_KEY')) return 'brave';
  if (cfg(env, 'GOOGLE_CSE_KEY') && cfg(env, 'GOOGLE_CSE_CX')) return 'google';
  if (cfg(env, 'SEARXNG_URL')) return 'searxng';
  return 'open';
}

export async function searchWeb(query, limit = 6, env = {}) {
  const engine = searchEngine(env);
  try {
    const hits = engine === 'brave' ? await braveSearch(query, limit, cfg(env, 'BRAVE_SEARCH_API_KEY'))
      : engine === 'google' ? await googleSearch(query, limit, cfg(env, 'GOOGLE_CSE_KEY'), cfg(env, 'GOOGLE_CSE_CX'))
      : engine === 'searxng' ? await searxngSearch(query, limit, cfg(env, 'SEARXNG_URL'))
      : [];
    if (hits.length >= 3) return hits;
  } catch { /* fall back to the keyless APIs */ }
  // Keyword search engines: a full sentence finds little, its keywords find more.
  const keywords = terms(query).slice(0, 8).join(' ') || query;
  const [wiki, hn] = await Promise.all([
    wikipediaSearch(keywords, limit).catch(() => []),
    hackerNewsSearch(keywords, Math.ceil(limit / 2)).catch(() => []),
  ]);
  const out = [];
  for (let i = 0; out.length < limit && i < limit; i++) {
    if (wiki[i]) out.push(wiki[i]);
    if (hn[i] && out.length < limit) out.push(hn[i]);
  }
  return out;
}

// Searches, crawls the top pages (robots.txt-aware, see _crawl.js) and returns
// sources with the passages that best match the question.
export async function deepSearch(env, query) {
  const sources = await crawl({ env, question: query, depth: 'quick', search: searchWeb });
  return sources.map((s) => ({ title: s.title, url: s.url, snippet: s.snippet, text: s.excerpt }));
}

export function sourcesBlock(sources) {
  return sources.map((s, i) => `[${i + 1}] ${s.title} (${s.url})\n${s.text}`).join('\n\n');
}
export function sourcesFooter(sources) {
  return sources.length ? `\n\n---\n**Sources**\n${sources.map((s, i) => `${i + 1}. [${s.title.replace(/[[\]]/g, '')}](${s.url})`).join('\n')}` : '';
}

// Splits a reasoning model's "<think>…</think>answer" output.
export function splitThinking(text = '') {
  const m = text.match(/^\s*(?:<think>)?([\s\S]*?)<\/think>\s*([\s\S]*)$/);
  return m ? { thinking: m[1].trim(), answer: m[2].trim() } : { thinking: '', answer: text.trim() };
}

// Accepts only small inline image data URLs.
export function cleanImages(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((d) => typeof d === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(d) && d.length < 2_800_000).slice(0, 4);
}

export async function imagine(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const prompt = String(body?.prompt || '').trim().slice(0, 2000);
  if (!prompt) return json({ error: 'Describe the image you want.' }, 400);
  if (!env.AI) return json({ error: 'Image generation is not configured.' }, 503);
  try {
    const out = await env.AI.run(IMAGE_MODEL, { prompt, steps: 6 });
    if (!out?.image) return json({ error: 'No image came back. Please retry.' }, 502);
    return json({ image: `data:image/jpeg;base64,${out.image}`, model: IMAGE_MODEL });
  } catch (err) {
    // The account's shared free Workers AI allowance (api/_ai-budget.js) is used up for today.
    if (err?.name === 'FreeAllowanceUsed') return json({ error: err.message }, 429);
    return json({ error: 'Image generation failed. Please retry.' }, 502);
  }
}

// Shared conversations live in KV for 90 days. Anyone with the link can read.
const SHARE_TTL = 60 * 60 * 24 * 90;
export async function share(request, env) {
  const kv = vaultKv(env);
  if (request.method === 'GET') {
    const id = new URL(request.url).searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) return json({ error: 'Bad link' }, 400);
    const raw = await kv.get(`share:${id}`);
    const snap = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    return snap ? json(snap) : json({ error: 'This shared chat was not found or has expired.' }, 404);
  }
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Forbidden' }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const snap = {
    title: String(body?.title || '').slice(0, 200),
    task: String(body?.task || '').slice(0, 6000),
    steps: (Array.isArray(body?.steps) ? body.steps : []).slice(0, 8).map((s) => ({
      name: String(s?.name || 'Agent').slice(0, 80),
      output: String(s?.output || '').slice(0, 40000),
      image: typeof s?.image === 'string' && s.image.startsWith('data:image/') && s.image.length < 1_500_000 ? s.image : undefined,
    })),
    createdAt: Date.now(),
  };
  if (!snap.task || !snap.steps.length) return json({ error: 'Nothing to share yet.' }, 400);
  const id = randomId(12);
  await kv.put(`share:${id}`, JSON.stringify(snap), { expirationTtl: SHARE_TTL });
  return json({ id });
}
