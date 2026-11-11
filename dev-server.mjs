// Zero-dependency local dev server: serves static files and runs /api/run
// the same way the Worker does (Web-standard Request -> Response handlers).
// Usage: ANTHROPIC_API_KEY=sk-... node dev-server.mjs   (key optional)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as runApi from './api/run.js';
import * as forecastApi from './api/forecast.js';
import * as connectorsApi from './api/connectors.js';
import * as automationsApi from './api/automations.js';
import { imagine, share } from './api/grok.js';
import * as scalvsAgentApi from './api/scalvs-agent.js';
import * as webSearchApi from './api/web-search.js';

const APIS = { '/api/run': runApi, '/api/forecast': forecastApi, '/api/imagine': { POST: imagine }, '/api/share': { GET: share, POST: share }, '/api/openclaw': scalvsAgentApi, '/api/search': webSearchApi };

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    const isConnectors = url.pathname.startsWith('/api/connectors') || url.pathname === '/api/oauth/callback';
    const isAutomations = url.pathname.startsWith('/api/automations');
    const api = isConnectors ? { [req.method]: connectorsApi.handle } : isAutomations ? { [req.method]: automationsApi.handle } : APIS[url.pathname];
    if (api) {
      const handler = api[req.method];
      if (!handler) { res.writeHead(405).end(); return; }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const request = new Request(url, { method: req.method, headers: req.headers, signal: abort.signal, body: chunks.length ? Buffer.concat(chunks) : undefined });
      const response = await handler(request);
      const outHeaders = Object.fromEntries(response.headers);
      const cookies = response.headers.getSetCookie?.() || [];
      if (cookies.length) outHeaders['set-cookie'] = cookies;
      res.writeHead(response.status, outHeaders);
      if (!response.body) { res.end(); return; }
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch { /* client went away */ }
      res.end();
      return;
    }
    const urlPath = url.pathname.replace(/\/+$/, '/');
    let path = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
    if (path === '/' || path === '\\') path = '/index.html';
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT) || !(await stat(file)).isFile()) throw new Error('not found');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => console.log(`SCALVS.ai dev server → http://localhost:${PORT}`));
