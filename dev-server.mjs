// Zero-dependency local dev server: serves static files and runs /api/run
// the same way the Worker does (Web-standard Request -> Response handlers).
// Usage: ANTHROPIC_API_KEY=sk-... node dev-server.mjs   (key optional)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as runApi from './api/run.js';
import * as forecastApi from './api/forecast.js';
import { applyGeoArgs, GEO_HELP } from './api/geo-settings.js';

const APIS = { '/api/run': runApi, '/api/forecast': forecastApi };

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 3000);

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(GEO_HELP);
  process.exit(0);
}
let geoOn = false;
try {
  geoOn = applyGeoArgs(process.argv.slice(2), process.env, ROOT);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    const api = APIS[url.pathname];
    if (api) {
      const handler = api[req.method];
      if (!handler) { res.writeHead(405).end(); return; }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const request = new Request(url, { method: req.method, headers: req.headers, signal: abort.signal, body: chunks.length ? Buffer.concat(chunks) : undefined });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
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
}).listen(PORT, () => {
  console.log(`SCALVS.ai dev server → http://localhost:${PORT}`);
  console.log(`Geo routing: ${geoOn ? 'on' : 'off'}`);
});
