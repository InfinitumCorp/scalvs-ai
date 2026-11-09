// Opt-in geo annotation. INFINITUM_GEO_ENABLED defaults off. When it is off
// this module does not read datasets, log, or change a response.

import { join } from 'node:path';
import {
  applyGeoPolicy, domainsIn, geoEnabled, loadGeoIPList, loadGeoSiteList, lookupCategories, lookupCountry,
} from '../src/geo.js';

let cache = null;
let cacheDir = '';
let unavailableLogged = false;

export function resetGeoCache() {
  cache = null;
  cacheDir = '';
  unavailableLogged = false;
}

function clientIp(request) {
  const headers = request?.headers;
  if (!headers?.get) return '';
  const direct = headers.get('cf-connecting-ip');
  if (direct) return direct.trim();
  const forwarded = headers.get('x-forwarded-for');
  if (!forwarded) return '';
  return forwarded.split(',')[0].trim();
}

async function installedData(env) {
  const dir = env?.INFINITUM_GEO_DIR || join(process.cwd(), 'data', 'geo');
  if (cache && cacheDir === dir) return cache;
  const { readFileSync } = await import('node:fs');
  const data = {
    ip: loadGeoIPList(readFileSync(join(dir, 'geoip.dat'))),
    site: loadGeoSiteList(readFileSync(join(dir, 'geosite.dat'))),
  };
  cache = data;
  cacheDir = dir;
  return data;
}

export async function annotateRequest(request, body, env = process.env) {
  if (!geoEnabled(env) || body?.geoRouting !== true) return null;
  try {
    const data = await installedData(env);
    const looked = lookupCountry(data.ip, clientIp(request));
    const categories = [];
    for (const domain of domainsIn(body?.task)) {
      for (const code of lookupCategories(data.site, domain)) {
        if (!categories.includes(code)) categories.push(code);
      }
    }
    const annotation = { country: looked.country, categories, precision: 'coarse' };
    const policy = applyGeoPolicy({}, annotation, true);
    const note = { country: policy.geo?.country || null, categories, precision: 'coarse' };
    console.log(JSON.stringify({ event: 'geo-annotation', ...note }));
    return note;
  } catch {
    if (!unavailableLogged) {
      unavailableLogged = true;
      console.log(JSON.stringify({ event: 'geo-annotation', status: 'unavailable', precision: 'coarse' }));
    }
    return null;
  }
}

export function withGeo(response, annotation) {
  if (!annotation) return response;
  const headers = new Headers(response.headers);
  headers.set('x-infinitum-geo', JSON.stringify(annotation));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
