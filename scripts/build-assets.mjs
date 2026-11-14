// Copies only the browser files into dist/ for Workers Static Assets, so api/,
// tests/ and config never become public URLs. Keeps the same relative layout
// index.html already uses (src/…, public/…).
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { browserConfig } from './browser-config.mjs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync('index.html', 'dist/index.html');
cpSync('privacy.html', 'dist/privacy.html');
cpSync('manifest.webmanifest', 'dist/manifest.webmanifest');
cpSync('sw.js', 'dist/sw.js');
cpSync('src', 'dist/src', { recursive: true });
cpSync('public', 'dist/public', { recursive: true });
// Browser config from the environment (src/config.js has the defaults).
writeFileSync('dist/src/config.js', browserConfig());
writeFileSync('dist/_headers', '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n/sw.js\n  Cache-Control: no-cache\n/manifest.webmanifest\n  Content-Type: application/manifest+json\n');
console.log('dist/ ready');
