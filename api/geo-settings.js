// Remembers the dev-server geo routing switch. Missing file means off.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function settingsPath(dir) {
  return join(dir, 'data', 'geo-settings.json');
}

export function readGeoRouting(dir) {
  try {
    const data = JSON.parse(readFileSync(settingsPath(dir), 'utf8'));
    return data.geoRouting === true;
  } catch {
    return false;
  }
}

export function writeGeoRouting(dir, on) {
  const path = settingsPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ geoRouting: on === true }, null, 2)}\n`);
  return on === true;
}

function truthy(value) {
  return ['1', 'true', 'on', 'yes'].includes(String(value ?? '').trim().toLowerCase());
}

export function applyGeoArgs(argv, env, dir) {
  const on = argv.includes('--geo');
  const off = argv.includes('--no-geo');
  if (on && off) throw new Error('Pass only one of --geo or --no-geo');
  if (on || off) {
    writeGeoRouting(dir, on);
    env.INFINITUM_GEO_ENABLED = on ? '1' : '0';
    return on;
  }
  if (env.INFINITUM_GEO_ENABLED == null || String(env.INFINITUM_GEO_ENABLED).trim() === '') {
    env.INFINITUM_GEO_ENABLED = readGeoRouting(dir) ? '1' : '0';
  }
  return truthy(env.INFINITUM_GEO_ENABLED);
}

export const GEO_HELP = `Usage: node dev-server.mjs [--geo | --no-geo]

  --geo      Turn geo routing on and remember that choice
  --no-geo   Turn geo routing off and remember that choice

Geo routing is off unless --geo was saved, or INFINITUM_GEO_ENABLED is 1.
The browser Options switch must also be on before a task is annotated.
Only a coarse country and site category are used.`;
