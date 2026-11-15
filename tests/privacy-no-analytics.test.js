// The Chrome extension privacy policy says "No analytics": privacy.html must load none, in source and in dist/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ANALYTICS = /amplitude|mixpanel|mxpnl|googletagmanager|gtag\(|posthog|segment\.com|plausible|umami/i;
const root = new URL('..', import.meta.url).pathname;

test('privacy.html loads no analytics', () => {
  assert.doesNotMatch(readFileSync(join(root, 'privacy.html'), 'utf8'), ANALYTICS);
});

test('the build copies privacy.html without adding analytics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scalvs-build-'));
  try {
    for (const f of ['index.html', 'privacy.html', 'manifest.webmanifest', 'sw.js', 'package.json']) cpSync(join(root, f), join(dir, f));
    for (const d of ['src', 'public', 'scripts']) cpSync(join(root, d), join(dir, d), { recursive: true });
    execFileSync(process.execPath, ['scripts/build-assets.mjs'], { cwd: dir, env: { ...process.env, MIXPANEL_PROJECT_TOKEN: '0123456789abcdef0123456789abcdef' }, stdio: 'ignore' });
    assert.doesNotMatch(readFileSync(join(dir, 'dist', 'privacy.html'), 'utf8'), ANALYTICS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
