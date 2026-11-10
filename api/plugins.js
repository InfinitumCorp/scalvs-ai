// Plug-ins: built-in tools a visitor can switch on for their agents (Connect →
// Plug-ins). All use free public APIs that need no keys and are meant for
// programmatic use. The client sends the enabled ids as body.plugins.

import { checkUrl } from './_vault.js';

const UA = 'SCALVS.ai-plugins/1.0 (+https://scalvs.app)';
async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------- calculator: a small recursive-descent parser (Workers forbid eval) ----------
const FNS = { sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, log: Math.log10, ln: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp };
const CONSTS = { pi: Math.PI, e: Math.E };
export function calculate(expr) {
  const src = String(expr).replace(/,/g, '').replace(/×/g, '*').replace(/÷/g, '/').toLowerCase();
  if (src.length > 300) throw new Error('Expression too long');
  let i = 0;
  const peek = () => src[i];
  const skip = () => { while (src[i] === ' ') i++; };
  const eat = (c) => { skip(); if (src[i] === c) { i++; return true; } return false; };
  function primary() {
    skip();
    if (eat('(')) { const v = add(); if (!eat(')')) throw new Error('Missing )'); return v; }
    if (eat('-')) return -power();
    if (eat('+')) return power();
    const num = src.slice(i).match(/^\d*\.?\d+(e[+-]?\d+)?/);
    if (num) { i += num[0].length; return Number(num[0]); }
    const name = src.slice(i).match(/^[a-z]+/);
    if (name) {
      i += name[0].length;
      if (name[0] in CONSTS) return CONSTS[name[0]];
      const fn = FNS[name[0]];
      if (!fn || !eat('(')) throw new Error(`Unknown name ${name[0]}`);
      const v = add();
      if (!eat(')')) throw new Error('Missing )');
      return fn(v);
    }
    throw new Error(`Unexpected "${peek() ?? 'end'}"`);
  }
  function postfix() { let v = primary(); skip(); while (src[i] === '%') { i++; v /= 100; skip(); } return v; }
  function power() { const b = postfix(); skip(); if (src[i] === '^' || src.startsWith('**', i)) { i += src[i] === '^' ? 1 : 2; return b ** power(); } return b; }
  function mul() { let v = power(); for (;;) { skip(); if (eat('*')) v *= power(); else if (eat('/')) v /= power(); else return v; } }
  function add() { let v = mul(); for (;;) { skip(); if (eat('+')) v += mul(); else if (eat('-')) v -= mul(); else return v; } }
  const v = add();
  skip();
  if (i < src.length) throw new Error(`Unexpected "${src[i]}"`);
  if (!Number.isFinite(v)) throw new Error('Result is not a finite number');
  return v;
}

const WEATHER_CODES = { 0: 'clear', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail' };

export const PLUGINS = [
  {
    id: 'calculator', name: 'Calculator', desc: 'Exact arithmetic: percentages, powers, roots, logs.',
    tool: {
      name: 'calculator', description: 'Evaluate a math expression exactly, e.g. "(1200*0.15)+sqrt(81)", "2^10", "15% * 80".',
      inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
      run: async ({ expression }) => `${expression} = ${calculate(expression)}`,
    },
  },
  {
    id: 'weather', name: 'Weather', desc: 'Current weather and 3-day forecast anywhere (Open-Meteo).',
    tool: {
      name: 'weather', description: 'Current weather and a 3-day forecast for a place name.',
      inputSchema: { type: 'object', properties: { place: { type: 'string' } }, required: ['place'] },
      run: async ({ place }) => {
        // The geocoder matches a place name only: try "Columbus Ohio", then "Columbus"
        // and prefer a result whose region/country matches the rest ("Ohio").
        const words = String(place).slice(0, 100).split(/[,\s]+/).filter(Boolean);
        let p = null;
        for (let n = words.length; n >= 1 && !p; n--) {
          const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=10&name=${encodeURIComponent(words.slice(0, n).join(' '))}`);
          const rest = words.slice(n).join(' ').toLowerCase();
          const list = geo.results || [];
          p = (rest && list.find((r) => [r.admin1, r.country, r.country_code].some((x) => x && (x.toLowerCase() === rest || x.toLowerCase().startsWith(rest))))) || list[0] || null;
        }
        if (!p) return `No place found for "${place}".`;
        const w = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&forecast_days=3&timezone=auto`);
        const c = w.current;
        const days = w.daily.time.map((d, k) => `${d}: ${WEATHER_CODES[w.daily.weather_code[k]] || 'mixed'}, ${w.daily.temperature_2m_min[k]}–${w.daily.temperature_2m_max[k]}°C, rain chance ${w.daily.precipitation_probability_max[k] ?? '?'}%`);
        return `${p.name}${p.admin1 ? `, ${p.admin1}` : ''}, ${p.country} (local time ${c.time})\nNow: ${WEATHER_CODES[c.weather_code] || 'mixed'}, ${c.temperature_2m}°C (feels ${c.apparent_temperature}°C), humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h\n${days.join('\n')}\nSource: open-meteo.com`;
      },
    },
  },
  {
    id: 'currency', name: 'Currency', desc: 'Live exchange rates and conversions (ECB data via Frankfurter).',
    tool: {
      name: 'currency_convert', description: 'Convert an amount between currencies at the latest ECB reference rate. Use ISO codes like USD, EUR, JPY.',
      inputSchema: { type: 'object', properties: { amount: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } }, required: ['amount', 'from', 'to'] },
      run: async ({ amount, from, to }) => {
        const f = String(from).toUpperCase().slice(0, 3);
        const t = String(to).toUpperCase().slice(0, 3);
        if (!/^[A-Z]{3}$/.test(f) || !/^[A-Z]{3}$/.test(t)) return 'Use 3-letter currency codes.';
        if (f === t) return `${amount} ${f} = ${amount} ${t}`;
        const d = await getJson(`https://api.frankfurter.dev/v1/latest?amount=${Number(amount) || 1}&from=${f}&to=${t}`);
        return `${d.amount} ${d.base} = ${d.rates?.[t]} ${t} (ECB reference rate, ${d.date}). Source: frankfurter.dev`;
      },
    },
  },
  {
    id: 'wikipedia', name: 'Wikipedia', desc: 'Look up encyclopedia summaries.',
    tool: {
      name: 'wikipedia', description: 'Get the Wikipedia summary for a topic.',
      inputSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
      run: async ({ topic }) => {
        const s = await getJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1&srsearch=${encodeURIComponent(String(topic).slice(0, 200))}`);
        const title = s.query?.search?.[0]?.title;
        if (!title) return `No Wikipedia article found for "${topic}".`;
        const d = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
        return `${d.title}: ${d.extract}\nSource: ${d.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`}`;
      },
    },
  },
  {
    id: 'reader', name: 'Web reader', desc: 'Read the text of any public web page you link.',
    tool: {
      name: 'read_url', description: 'Fetch a public https web page and return its readable text.',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      run: async ({ url }, env) => {
        checkUrl(url, env);
        const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,text/plain' }, redirect: 'manual', signal: AbortSignal.timeout(8000) });
        if (res.status >= 300 && res.status < 400) return `The page redirects to ${res.headers.get('location')}. Call read_url with that URL if it is public.`;
        if (!res.ok) return `The site answered HTTP ${res.status}.`;
        const html = (await res.text()).slice(0, 400000);
        const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
        const text = html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/\s+/g, ' ').trim();
        return `Title: ${title.trim()}\nURL: ${url}\n\n${text.slice(0, 8000)}`;
      },
    },
  },
  {
    id: 'clock', name: 'World clock', desc: 'Current date and time in any time zone.',
    tool: {
      name: 'world_clock', description: 'Current date and time in an IANA time zone such as "America/New_York" or "Asia/Tokyo". Defaults to UTC.',
      inputSchema: { type: 'object', properties: { timezone: { type: 'string' } } },
      run: async ({ timezone } = {}) => {
        const tz = timezone || 'UTC';
        try {
          return `${new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' }).format(new Date())} (${tz})`;
        } catch { return `Unknown time zone "${tz}". Use an IANA name like Europe/London.`; }
      },
    },
  },
];

// Tools for the enabled plug-in ids, in the shape runToolLoop expects.
export function pluginTools(ids, env) {
  if (!Array.isArray(ids)) return [];
  return PLUGINS.filter((p) => ids.includes(p.id)).map((p) => ({
    name: p.tool.name,
    label: `${p.name} · ${p.tool.name}`,
    description: p.tool.description,
    inputSchema: p.tool.inputSchema,
    run: (args) => p.tool.run(args || {}, env),
  }));
}
