// src/config.js as served to browsers, filled from environment variables.
// Used by scripts/build-assets.mjs (dist/) and dev-server.mjs. Only public values
// belong here: everything in this file is readable by anyone who opens the app.
import { readFileSync } from 'node:fs';

const DEFAULTS = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
const defaultOf = (name) => DEFAULTS.match(new RegExp(`export const ${name} = '([^']*)'`))?.[1] ?? '';

/** Accepts only plain https origins (http for localhost) so a bad variable can't inject script. */
export function cleanUrl(value, fallback) {
  try {
    const u = new URL(String(value ?? '').trim());
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return fallback;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return fallback;
  }
}

export function browserConfig(env = process.env) {
  const revenue = cleanUrl(env.REVENUE_URL, defaultOf('REVENUE_URL'));
  return `// Generated from environment variables by scripts/browser-config.mjs.\nexport const REVENUE_URL = ${JSON.stringify(revenue)};\n`;
}
