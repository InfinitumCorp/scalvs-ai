// Syntax-checks every runtime source file (cross-platform replacement for a shell loop).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const files = ['dev-server.mjs',
  'worker.js', ...readdirSync('api').filter(f => f.endsWith('.js')).map(f => join('api', f)),
  ...readdirSync('src').filter(f => f.endsWith('.js')).map(f => join('src', f)),
  ...readdirSync('src/views').filter(f => f.endsWith('.js')).map(f => join('src/views', f)),
  ...readdirSync('src/i18n').filter(f => f.endsWith('.js')).map(f => join('src/i18n', f))];
for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
console.log(`Syntax OK: ${files.length} files`);
