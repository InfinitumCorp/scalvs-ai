// Minimal v2ray GeoIPList / GeoSiteList reader.
// Wire format: https://github.com/v2fly/v2ray-core/blob/master/app/router/routercommon/common.proto
// No extra dependencies. Unknown fields are skipped so the v2fly geoip plugin
// schema and the router schema both decode.

const textDecoder = new TextDecoder();

function readVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, i];
    shift += 7n;
    if (shift > 70n) throw new Error('Geo data varint is too long');
  }
  throw new Error('Geo data ended inside a varint');
}

function decodeFields(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const fields = [];
  let i = 0;
  while (i < bytes.length) {
    const [key, next] = readVarint(bytes, i);
    i = next;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (!Number.isSafeInteger(field) || field <= 0) throw new Error('Geo data field number is invalid');
    if (wire === 0) {
      const [value, after] = readVarint(bytes, i);
      i = after;
      fields.push({ field, wire, value });
    } else if (wire === 1) {
      if (i + 8 > bytes.length) throw new Error('Geo data ended inside a fixed64');
      i += 8;
    } else if (wire === 2) {
      const [length, after] = readVarint(bytes, i);
      i = after;
      const size = Number(length);
      if (!Number.isSafeInteger(size) || size < 0 || i + size > bytes.length) {
        throw new Error('Geo data ended inside a length-delimited field');
      }
      fields.push({ field, wire, value: bytes.subarray(i, i + size) });
      i += size;
    } else if (wire === 5) {
      if (i + 4 > bytes.length) throw new Error('Geo data ended inside a fixed32');
      i += 4;
    } else {
      throw new Error(`Geo data uses unsupported wire type ${wire}`);
    }
  }
  return fields;
}

function text(bytes) {
  return textDecoder.decode(bytes);
}

function parseCidr(buf) {
  let ip = new Uint8Array();
  let prefix = 0;
  for (const field of decodeFields(buf)) {
    if (field.field === 1 && field.wire === 2) ip = new Uint8Array(field.value);
    else if (field.field === 2 && field.wire === 0) prefix = Number(field.value);
  }
  return { ip, prefix };
}

function parseGeoIP(buf) {
  let code = '';
  const cidrs = [];
  let inverseMatch = false;
  for (const field of decodeFields(buf)) {
    if (field.field === 1 && field.wire === 2) code = text(field.value);
    else if (field.field === 2 && field.wire === 2) cidrs.push(parseCidr(field.value));
    else if (field.field === 3 && field.wire === 0) inverseMatch = field.value !== 0n;
  }
  return { code, cidrs, inverseMatch };
}

function parseAttribute(buf) {
  const attribute = { key: '' };
  for (const field of decodeFields(buf)) {
    if (field.field === 1 && field.wire === 2) attribute.key = text(field.value);
    else if (field.field === 2 && field.wire === 0) attribute.boolValue = field.value !== 0n;
    else if (field.field === 3 && field.wire === 0) attribute.intValue = field.value;
  }
  return attribute;
}

function parseDomain(buf) {
  let type = 0;
  let value = '';
  const attributes = [];
  for (const field of decodeFields(buf)) {
    if (field.field === 1 && field.wire === 0) type = Number(field.value);
    else if (field.field === 2 && field.wire === 2) value = text(field.value);
    else if (field.field === 3 && field.wire === 2) attributes.push(parseAttribute(field.value));
  }
  return { type, value, attributes };
}

function parseGeoSite(buf) {
  let code = '';
  const domains = [];
  for (const field of decodeFields(buf)) {
    if (field.field === 1 && field.wire === 2) code = text(field.value);
    else if (field.field === 2 && field.wire === 2) domains.push(parseDomain(field.value));
  }
  return { code, domains };
}

function addCode(map, key, code) {
  if (!key || !code) return;
  const list = map.get(key);
  if (list) {
    if (!list.includes(code)) list.push(code);
  } else map.set(key, [code]);
}

export function loadGeoIPList(buf) {
  const entries = [];
  for (const field of decodeFields(buf)) {
    if (field.field === 1 && field.wire === 2) entries.push(parseGeoIP(field.value));
  }
  return { entries };
}

export function loadGeoSiteList(buf) {
  const entries = [];
  const full = new Map();
  const root = new Map();
  const plain = [];
  const regex = [];
  for (const field of decodeFields(buf)) {
    if (field.field !== 1 || field.wire !== 2) continue;
    const entry = parseGeoSite(field.value);
    entries.push(entry);
    for (const domain of entry.domains) {
      const value = domain.value.trim().toLowerCase().replace(/\.$/, '');
      if (!value) continue;
      if (domain.type === 3) addCode(full, value, entry.code);
      else if (domain.type === 2) addCode(root, value, entry.code);
      else if (domain.type === 0) plain.push({ value, code: entry.code });
      else if (domain.type === 1 && domain.value.length <= 200) {
        try { regex.push({ re: new RegExp(domain.value, 'i'), code: entry.code }); } catch { /* skip a bad pattern */ }
      }
    }
  }
  return { entries, full, root, plain, regex };
}

export function parseIp(input) {
  if (typeof input !== 'string') return null;
  let value = input.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  if (value.includes(':')) return parseIpv6(value);
  return parseIpv4(value);
}

function parseIpv4(value) {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseIpv6(value) {
  let tail = null;
  let body = value;
  if (body.includes('.')) {
    const split = body.lastIndexOf(':');
    if (split < 0) return null;
    tail = parseIpv4(body.slice(split + 1));
    if (!tail) return null;
    body = body.slice(0, split);
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const back = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groupsNeeded = tail ? 6 : 8;
  if (halves.length === 1 && head.length !== groupsNeeded) return null;
  if (head.length + back.length > groupsNeeded) return null;
  const missing = groupsNeeded - head.length - back.length;
  const groups = halves.length === 2
    ? [...head, ...Array(missing).fill('0'), ...back]
    : head;
  if (groups.length !== groupsNeeded) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < groups.length; i += 1) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const n = Number.parseInt(groups[i], 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  if (tail) out.set(tail, 12);
  return out;
}

function cidrContains(ip, cidr) {
  if (!(ip instanceof Uint8Array) || !(cidr?.ip instanceof Uint8Array)) return false;
  if (ip.length !== cidr.ip.length || (ip.length !== 4 && ip.length !== 16)) return false;
  const bits = ip.length * 8;
  if (!Number.isInteger(cidr.prefix) || cidr.prefix < 0 || cidr.prefix > bits) return false;
  if (cidr.prefix === 0) return true;
  const full = Math.floor(cidr.prefix / 8);
  const rem = cidr.prefix % 8;
  for (let i = 0; i < full; i += 1) if (ip[i] !== cidr.ip[i]) return false;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (ip[full] & mask) === (cidr.ip[full] & mask);
}

function comparableIp(bytes) {
  if (bytes.length !== 16) return bytes;
  for (let i = 0; i < 10; i += 1) if (bytes[i] !== 0) return bytes;
  if (bytes[10] === 0xff && bytes[11] === 0xff) return bytes.subarray(12);
  return bytes;
}

export function lookupCountry(list, ip) {
  const parsed = typeof ip === 'string' ? parseIp(ip) : null;
  const bytes = parsed ? comparableIp(parsed) : null;
  if (!bytes || !list?.entries) return { country: null, codes: [] };
  const codes = [];
  for (const entry of list.entries) {
    const inside = entry.cidrs.some((cidr) => cidrContains(bytes, cidr));
    if (entry.inverseMatch ? !inside : inside) codes.push(entry.code);
  }
  const country = codes.find((code) => /^[A-Za-z]{2}$/.test(code));
  return { country: country ? country.toUpperCase() : null, codes };
}

export function normalizeDomain(input) {
  if (typeof input !== 'string') return null;
  let domain = input.trim().toLowerCase();
  if (!domain || domain.length > 253) return null;
  if (domain.includes('://')) {
    try { domain = new URL(domain).hostname.toLowerCase(); } catch { return null; }
  }
  if (domain.endsWith('.')) domain = domain.slice(0, -1);
  if (!domain || !/^[a-z0-9.-]+$/.test(domain)) return null;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return null;
  return domain;
}

export function lookupCategories(list, domain) {
  const name = normalizeDomain(domain);
  if (!name || !list) return [];
  const found = [];
  const add = (code) => { if (code && !found.includes(code)) found.push(code); };
  for (const code of list.full?.get(name) || []) add(code);
  let rest = name;
  while (rest) {
    for (const code of list.root?.get(rest) || []) add(code);
    const dot = rest.indexOf('.');
    if (dot < 0) break;
    rest = rest.slice(dot + 1);
  }
  for (const rule of list.plain || []) if (name.includes(rule.value)) add(rule.code);
  for (const rule of list.regex || []) if (rule.re.test(name)) add(rule.code);
  return found;
}

export function geoEnabled(env = process.env) {
  const value = env?.INFINITUM_GEO_ENABLED;
  if (value == null || String(value).trim() === '') return false;
  return ['1', 'true', 'on', 'yes'].includes(String(value).trim().toLowerCase());
}

// Coarse country only. An IP, a city, or any other precise location is ignored.
export function applyGeoPolicy(record, annotation, enabled) {
  if (enabled !== true || !annotation || record == null || typeof record !== 'object') return record;
  const country = annotation.country;
  if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) return record;
  record.geo = { country, precision: 'coarse' };
  return record;
}

export function domainsIn(text) {
  if (typeof text !== 'string' || !text) return [];
  const found = [];
  for (const match of text.matchAll(/\b(?:[a-z0-9-]+\.)+[a-z]{2,24}\b/gi)) {
    const domain = normalizeDomain(match[0]);
    if (domain && !found.includes(domain)) found.push(domain);
    if (found.length >= 8) break;
  }
  return found;
}
