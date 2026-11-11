// Grok-style extras for SCALVS.ai, all on free backends (Workers AI + public web):
//   DeepSearch  web search -> read top pages -> answer with numbered citations
//   Think       a reasoning model; its <think> trace is returned separately
//   Vision      image attachments read by a multimodal model
//   Imagine     POST /api/imagine {prompt} -> {image: data URL}
//   Share       POST /api/share {title, task, steps} -> {id};  GET /api/share?id= -> snapshot

import { cfg, checkUrl, kv as vaultKv, randomId } from './_vault.js';

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

async function getText(url, ms = 6000) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/json' }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Brave Search API when BRAVE_SEARCH_API_KEY is set (free tier: 2,000 queries/month,
// https://brave.com/search/api/). Otherwise DuckDuckGo's HTML endpoint, requested
// with an honest bot user agent (it may refuse requests from cloud servers), and
// Wikipedia's API as a fallback that always answers.
async function braveSearch(query, limit, key) {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, {
    headers: { accept: 'application/json', 'x-subscription-token': key }, signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Brave ${res.status}`);
  const data = await res.json();
  return (data.web?.results || []).map((r) => ({ title: strip(r.title || ''), url: r.url, snippet: strip(r.description || '') }))
    .filter((r) => /^https:\/\//.test(r.url));
}

async function searchWeb(query, limit = 6, env = {}) {
  const key = cfg(env, 'BRAVE_SEARCH_API_KEY');
  if (key) {
    try { const hits = await braveSearch(query, limit, key); if (hits.length) return hits; } catch { /* fall back */ }
  }
  const hits = [];
  try {
    const html = await getText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && hits.length < limit) {
      let url = m[1].replace(/&amp;/g, '&');
      const u = url.match(/[?&]uddg=([^&]+)/);
      if (u) url = decodeURIComponent(u[1]);
      if (url.startsWith('//')) url = `https:${url}`;
      if (!/^https:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
      hits.push({ title: strip(m[2]), url, snippet: strip(m[3]) });
    }
  } catch { /* fall through */ }
  if (hits.length < 3) {
    try {
      const data = JSON.parse(await getText(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${limit}&srsearch=${encodeURIComponent(query)}`));
      for (const r of data.query?.search || []) {
        if (hits.length >= limit) break;
        hits.push({ title: r.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`, snippet: strip(r.snippet) });
      }
    } catch { /* no results */ }
  }
  return hits;
}

// Searches, reads the top pages in parallel, and returns sources with excerpts.
export async function deepSearch(env, query, { pages = 4 } = {}) {
  const hits = await searchWeb(query.slice(0, 300), 6, env);
  const read = await Promise.all(hits.slice(0, pages).map(async (h) => {
    try { checkUrl(h.url, env); return { ...h, text: strip(await getText(h.url)).slice(0, 3500) }; } catch { return { ...h, text: h.snippet }; }
  }));
  return [...read, ...hits.slice(pages).map((h) => ({ ...h, text: h.snippet }))];
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
