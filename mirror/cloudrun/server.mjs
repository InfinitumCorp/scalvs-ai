// SCALVS.ai mirror: a reverse proxy to https://scalvs.app on Google Cloud Run.
// Some networks (for example in Russia) throttle Cloudflare, where scalvs.app
// lives; Google's run.app hosts stay reachable. See ../README.md.
import http from 'node:http';
import { Readable } from 'node:stream';

const ORIGIN = 'https://scalvs.app';
const PORT = Number(process.env.PORT || 8080);
// Hop-by-hop headers, plus Origin/Referer: the API rejects a cross-site Origin.
const DROP_REQ = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-connection', 'te', 'trailer', 'origin', 'referer', 'x-forwarded-host', 'forwarded']);
const DROP_RES = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding',
  'content-length', 'alt-svc', 'strict-transport-security']);

http.createServer(async (req, res) => {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!DROP_REQ.has(k)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    // fetch() unpacks gzip and brotli but not zstd, which phones ask for; the
    // reply goes out unpacked (content-encoding is dropped below).
    headers['accept-encoding'] = 'gzip, br';
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const upstream = await fetch(ORIGIN + req.url, {
      method: req.method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
    });
    const out = {};
    upstream.headers.forEach((v, k) => {
      if (DROP_RES.has(k) || k === 'set-cookie') return;
      out[k] = k === 'location' ? v.replace(/^https:\/\/(www\.)?scalvs\.app/i, 'https://' + host) : v;
    });
    const cookies = upstream.headers.getSetCookie?.() || [];
    if (cookies.length) out['set-cookie'] = cookies.map((c) => c.replace(/;\s*domain=[^;]*/i, ''));
    res.writeHead(upstream.status, out);
    if (!upstream.body || req.method === 'HEAD') return res.end();
    // Stream (SSE replies arrive piece by piece).
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (error) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Mirror could not reach SCALVS.ai.');
    console.error(error);
  }
}).listen(PORT, () => console.log(`mirror on :${PORT} → ${ORIGIN}`));
