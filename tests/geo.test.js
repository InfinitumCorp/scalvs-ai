import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyGeoPolicy, domainsIn, geoEnabled, loadGeoIPList, loadGeoSiteList,
  lookupCategories, lookupCountry, normalizeDomain, parseIp,
} from '../src/geo.js';
import { annotateRequest, resetGeoCache, withGeo } from '../api/geo.js';
import { applyGeoArgs, readGeoRouting } from '../api/geo-settings.js';
import {
  assertChecksum, assertV2flyReleaseUrl, installDatasets, loadLock, parseSha256Sum, sha256,
} from '../scripts/fetch-geo.mjs';
import { collect, emptyExchange } from '../src/exchange.js';

const varint = (n) => {
  const bytes = [];
  let value = BigInt(n);
  while (value > 127n) {
    bytes.push(Number((value & 127n) | 128n));
    value >>= 7n;
  }
  bytes.push(Number(value));
  return Buffer.from(bytes);
};
const key = (field, wire) => varint((BigInt(field) << 3n) | BigInt(wire));
const lengthDelimited = (field, buf) => {
  const body = Buffer.from(buf);
  return Buffer.concat([key(field, 2), varint(body.length), body]);
};
const str = (field, value) => lengthDelimited(field, Buffer.from(value));
const vi = (field, n) => Buffer.concat([key(field, 0), varint(n)]);
const ipv4 = (ip) => Buffer.from(ip.split('.').map(Number));
const cidr = (ip, prefix) => Buffer.concat([
  lengthDelimited(1, typeof ip === 'string' ? ipv4(ip) : ip),
  vi(2, prefix),
]);
const geoip = (code, cidrs, inverse = false) => Buffer.concat([
  str(1, code),
  ...cidrs.map((item) => lengthDelimited(2, item)),
  ...(inverse ? [vi(3, 1)] : []),
]);
const geoipList = (entries) => Buffer.concat(entries.map((entry) => lengthDelimited(1, entry)));
const domain = (type, value, attributes = []) => Buffer.concat([
  vi(1, type),
  str(2, value),
  ...attributes.map((item) => lengthDelimited(3, item)),
]);
const attribute = (name, bool) => Buffer.concat([str(1, name), vi(2, bool ? 1 : 0)]);
const geosite = (code, domains) => Buffer.concat([
  str(1, code),
  ...domains.map((item) => lengthDelimited(2, item)),
]);
const geositeList = (entries) => Buffer.concat(entries.map((entry) => lengthDelimited(1, entry)));

const ipFixture = () => geoipList([
  geoip('us', [cidr('1.2.3.0', 24), cidr('8.8.8.8', 32), cidr(Buffer.concat([Buffer.from([0x20, 0x01, 0x0d, 0xb8]), Buffer.alloc(12)]), 32)]),
  geoip('cn', [cidr('1.0.1.0', 24)]),
  geoip('private', [cidr('10.0.0.0', 8)]),
  geoip('not-private', [cidr('10.0.0.0', 8)], true),
  // Unknown fixed32 field must not stop the decode.
  Buffer.concat([geoip('ca', [cidr('9.9.9.0', 30)]), key(9, 5), Buffer.from([0, 0, 0, 0])]),
]);

const siteFixture = () => geositeList([
  geosite('google', [
    domain(2, 'google.com', [attribute('cn', false)]),
    domain(3, 'www.google.com'),
  ]),
  geosite('ads', [domain(0, 'doubleclick'), domain(1, '^ads\\.')]),
  geosite('cn', [domain(2, 'baidu.com')]),
]);

test('synthetic geoip fixtures resolve country and ignore non-country codes', () => {
  const list = loadGeoIPList(ipFixture());
  assert.equal(lookupCountry(list, '1.2.3.4').country, 'US');
  assert.deepEqual(lookupCountry(list, '1.2.3.4').codes, ['us', 'not-private']);
  assert.equal(lookupCountry(list, '1.2.3.255').country, 'US');
  assert.equal(lookupCountry(list, '1.2.4.0').country, null);
  assert.equal(lookupCountry(list, '8.8.8.8').country, 'US');
  assert.equal(lookupCountry(list, '8.8.8.9').country, null);
  assert.equal(lookupCountry(list, '1.0.1.5').country, 'CN');
  assert.equal(lookupCountry(list, '9.9.9.1').country, 'CA');
  assert.equal(lookupCountry(list, '9.9.9.4').country, null);
  const privateIp = lookupCountry(list, '10.1.2.3');
  assert.equal(privateIp.country, null);
  assert.deepEqual(privateIp.codes, ['private']);
  assert.equal(lookupCountry(list, '2001:db8::1').country, 'US');
  assert.equal(lookupCountry(list, '::ffff:1.2.3.4').country, 'US');
  assert.equal(lookupCountry(list, 'not-an-ip').country, null);
  assert.equal(parseIp('::1')?.length, 16);
});

test('synthetic geosite fixtures resolve domain categories', () => {
  const list = loadGeoSiteList(siteFixture());
  assert.equal(list.entries[0].domains[0].attributes[0].key, 'cn');
  assert.equal(list.entries[0].domains[0].attributes[0].boolValue, false);
  assert.deepEqual(lookupCategories(list, 'www.google.com').sort(), ['google']);
  assert.deepEqual(lookupCategories(list, 'mail.google.com'), ['google']);
  assert.deepEqual(lookupCategories(list, 'Google.COM.'), ['google']);
  assert.deepEqual(lookupCategories(list, 'https://news.google.com/path'), ['google']);
  assert.deepEqual(lookupCategories(list, 'notgoogle.com'), []);
  assert.deepEqual(lookupCategories(list, 'ads.example.com'), ['ads']);
  assert.ok(lookupCategories(list, 'cdn.doubleclick.net').includes('ads'));
  assert.deepEqual(lookupCategories(list, 'www.baidu.com'), ['cn']);
  assert.equal(normalizeDomain(''), null);
});

test('truncated geo data is rejected', () => {
  assert.throws(() => loadGeoIPList(Buffer.from([0x0a])), /ended inside/);
});

test('geo policy stays off and stores only a coarse country', () => {
  assert.equal(geoEnabled({}), false);
  assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: '0' }), false);
  assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: '' }), false);
  assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: '1' }), true);
  const record = {};
  applyGeoPolicy(record, { country: 'US', ip: '1.2.3.4' }, false);
  assert.deepEqual(record, {});
  applyGeoPolicy(record, { country: '1.2.3.4' }, true);
  assert.deepEqual(record, {});
  applyGeoPolicy(record, { country: 'US' }, true);
  assert.deepEqual(record.geo, { country: 'US', precision: 'coarse' });
  assert.equal(record.ip, undefined);

  const ex = emptyExchange();
  const state = { runs: [{ id: 'r1', task: 'hello', status: 'completed' }], forecasts: [] };
  collect(state, ex);
  assert.equal(ex.geo, undefined);
  assert.equal(ex.points.usage, 3);
  const again = emptyExchange();
  collect(state, again, { geoEnabled: false, geo: { country: 'US' } });
  assert.equal(again.geo, undefined);
  assert.equal(again.points.usage, 3);
  const opted = emptyExchange();
  collect({ runs: [{ id: 'r2', task: 'hello', status: 'completed' }], forecasts: [] }, opted, { geoEnabled: true, geo: { country: 'US' } });
  assert.deepEqual(opted.geo, { country: 'US', precision: 'coarse' });
  assert.equal(opted.points.usage, 3);
  assert.equal(opted.points.region, 1);
});

test('domains are taken from task text only', () => {
  assert.deepEqual(domainsIn('Check mail.google.com and https://baidu.com/a today.'), ['mail.google.com', 'baidu.com']);
});

test('lockfile matches the official v2fly checksum lines', () => {
  const lock = loadLock();
  const byFile = Object.fromEntries(lock.datasets.map((item) => [item.file, item]));
  assert.equal(parseSha256Sum('eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2  geoip.dat\n', 'geoip.dat'), byFile['geoip.dat'].sha256);
  assert.equal(parseSha256Sum('dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2  dlc.dat\n', 'dlc.dat'), byFile['geosite.dat'].sha256);
  assert.equal(byFile['geoip.dat'].tag, '202611080027');
  assert.equal(byFile['geosite.dat'].asset, 'dlc.dat');
  assert.equal(byFile['geosite.dat'].tag, '20261108011013');
  for (const item of lock.datasets) assertV2flyReleaseUrl(item.url, item);
  assert.throws(() => assertV2flyReleaseUrl(
    'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/x/geoip.dat',
    { repo: 'geoip', asset: 'geoip.dat' },
  ), /non-v2fly|Refusing/);
  assert.throws(() => assertV2flyReleaseUrl(
    'https://github.com/SagerNet/sing-box/releases/download/x/geoip.dat',
    { repo: 'geoip', asset: 'geoip.dat' },
  ), /non-v2fly|Refusing/);
});

test('fetch refuses a checksum mismatch and writes nothing', async () => {
  const dest = mkdtempSync(join(tmpdir(), 'geo-mismatch-'));
  const item = loadLock().datasets[0];
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === item.checksumUrl) return new Response(`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ${item.asset}\n`);
    return new Response(Buffer.from('should-not-download'));
  };
  await assert.rejects(() => installDatasets({ lock: { datasets: [item] }, destDir: dest, fetchImpl }), /checksum mismatch/);
  assert.deepEqual(calls, [item.checksumUrl]);
  assert.deepEqual(readdirSync(dest), []);
});

test('fetch writes a dataset only when the bytes match the official checksum', async () => {
  const dest = mkdtempSync(join(tmpdir(), 'geo-ok-'));
  const bytes = Buffer.from('synthetic-geo');
  const digest = sha256(bytes);
  const item = {
    ...loadLock().datasets[0],
    sha256: digest,
  };
  let downloads = 0;
  const fetchImpl = async (url) => {
    if (url === item.checksumUrl) return new Response(`${digest}  ${item.asset}\n`);
    downloads += 1;
    return new Response(bytes);
  };
  const written = await installDatasets({ lock: { datasets: [item] }, destDir: dest, fetchImpl });
  assert.equal(downloads, 1);
  assert.equal(written[0].file, 'geoip.dat');
  assert.equal(sha256(readFileSync(join(dest, 'geoip.dat'))), digest);
  const bad = mkdtempSync(join(tmpdir(), 'geo-bad-bytes-'));
  const badFetch = async (url) => {
    if (url === item.checksumUrl) return new Response(`${digest}  ${item.asset}\n`);
    return new Response(Buffer.from('tampered'));
  };
  await assert.rejects(() => installDatasets({ lock: { datasets: [item] }, destDir: bad, fetchImpl: badFetch }), /checksum mismatch/);
  assert.deepEqual(readdirSync(bad), []);
  assert.throws(() => assertChecksum('sample', 'abc', digest), /mismatch/);
});

test('the dev-server switch defaults off and can be remembered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-settings-'));
  const env = {};
  assert.equal(applyGeoArgs([], env, dir), false);
  assert.equal(env.INFINITUM_GEO_ENABLED, '0');
  assert.equal(readGeoRouting(dir), false);
  const saved = {};
  assert.equal(applyGeoArgs(['--geo'], saved, dir), true);
  assert.equal(saved.INFINITUM_GEO_ENABLED, '1');
  const again = {};
  assert.equal(applyGeoArgs([], again, dir), true);
  assert.equal(applyGeoArgs(['--no-geo'], {}, dir), false);
  assert.equal(readGeoRouting(dir), false);
  const pinned = { INFINITUM_GEO_ENABLED: '1' };
  assert.equal(applyGeoArgs([], pinned, dir), true);
  assert.equal(pinned.INFINITUM_GEO_ENABLED, '1');
  assert.throws(() => applyGeoArgs(['--geo', '--no-geo'], {}, dir), /only one/);
});

test('annotation is absent unless geo routing is opted in', async () => {
  const previous = process.env.INFINITUM_GEO_ENABLED;
  const previousDir = process.env.INFINITUM_GEO_DIR;
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousFetch = globalThis.fetch;
  const dir = mkdtempSync(join(tmpdir(), 'geo-annotate-'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'geoip.dat'), ipFixture());
  writeFileSync(join(dir, 'geosite.dat'), siteFixture());
  resetGeoCache();
  const request = () => new Request('http://localhost/api/run', {
    method: 'POST',
    headers: { 'cf-connecting-ip': '1.2.3.4', 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'Summarize www.google.com', geoRouting: true }),
  });
  try {
    delete process.env.INFINITUM_GEO_ENABLED;
    const off = await annotateRequest(request(), { task: 'Summarize www.google.com', geoRouting: true }, process.env);
    assert.equal(off, null);

    process.env.INFINITUM_GEO_ENABLED = '1';
    process.env.INFINITUM_GEO_DIR = dir;
    const skipped = await annotateRequest(request(), { task: 'Summarize www.google.com' }, process.env);
    assert.equal(skipped, null);

    const note = await annotateRequest(request(), { task: 'Summarize www.google.com', geoRouting: true }, process.env);
    assert.equal(note.country, 'US');
    assert.deepEqual(note.categories, ['google']);
    assert.equal(note.precision, 'coarse');
    assert.equal(JSON.stringify(note).includes('1.2.3.4'), false);

    process.env.ANTHROPIC_API_KEY = 'test-only';
    globalThis.fetch = async () => Response.json({
      model: 'test-model',
      content: [{ type: 'text', text: 'Draft memo' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const { POST } = await import('../api/run.js');
    const enabled = await POST(request());
    const body = await enabled.json();
    assert.equal(body.output, 'Draft memo');
    assert.equal(body.mode, 'live');
    assert.deepEqual(JSON.parse(enabled.headers.get('x-infinitum-geo')), note);

    process.env.INFINITUM_GEO_ENABLED = '0';
    const disabled = await POST(request());
    const disabledBody = await disabled.json();
    assert.equal(disabledBody.output, 'Draft memo');
    assert.equal(disabled.headers.get('x-infinitum-geo'), null);
    assert.equal(withGeo(disabled, null), disabled);
  } finally {
    if (previous === undefined) delete process.env.INFINITUM_GEO_ENABLED;
    else process.env.INFINITUM_GEO_ENABLED = previous;
    if (previousDir === undefined) delete process.env.INFINITUM_GEO_DIR;
    else process.env.INFINITUM_GEO_DIR = previousDir;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
    resetGeoCache();
  }
});

test('the options switch defaults off and is persisted in the browser store', async () => {
  const memory = new Map();
  globalThis.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, value),
  };
  const store = await import('../src/store.js');
  const connect = await import('../src/views/connect.js');
  const runner = await import('../src/runner.js');
  store.reset();
  assert.equal(store.getState().geoRouting, false);
  const off = connect.render();
  assert.match(off, /data-action="geo-routing"/);
  assert.doesNotMatch(off, /data-action="geo-routing" checked/);
  const agent = store.getState().agents[0];
  assert.equal('geoRouting' in runner.agentPayload(agent, 'Task', undefined, false), false);
  store.update((state) => { state.geoRouting = true; });
  assert.match(connect.render(), /data-action="geo-routing" checked/);
  assert.equal(runner.agentPayload(agent, 'Task', undefined, true).geoRouting, true);
  const saved = JSON.parse(memory.get('scalvs.state.v1'));
  assert.equal(saved.geoRouting, true);
});
