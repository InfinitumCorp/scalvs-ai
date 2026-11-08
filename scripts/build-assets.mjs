// Copies only the browser files into dist/ for Workers Static Assets, so api/,
// tests/ and config never become public URLs. Keeps the same relative layout
// index.html already uses (src/…, public/…).
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync('index.html', 'dist/index.html');
cpSync('privacy.html', 'dist/privacy.html');
cpSync('src', 'dist/src', { recursive: true });
cpSync('public', 'dist/public', { recursive: true });
writeFileSync('dist/_headers', '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n');
console.log('dist/ ready');
