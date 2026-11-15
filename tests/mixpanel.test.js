// Mixpanel boot: generated from the environment, off without a token, privacy-first SDK options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mixpanelBoot } from '../scripts/mixpanel-boot.mjs';

const TOKEN = '0123456789abcdef0123456789abcdef';
const calls = (src) => {
  const seen = [];
  new Function('initInfinitumMixpanel', src)((...a) => seen.push(a));
  return seen;
};

test('no token: the boot script is inert', () => {
  assert.deepEqual(calls(mixpanelBoot({})), []);
  assert.deepEqual(calls(mixpanelBoot({ MIXPANEL_PROJECT_TOKEN: 'not-a-token' })), []);
  assert.deepEqual(calls(readFileSync(new URL('../public/mixpanel-boot.js', import.meta.url), 'utf8')), []);
});

test('a token turns it on (US default, EU when set), tagged product=scalvs', () => {
  assert.deepEqual(calls(mixpanelBoot({ MIXPANEL_PROJECT_TOKEN: TOKEN })), [[TOKEN, { region: 'US', product: 'scalvs' }]]);
  assert.deepEqual(calls(mixpanelBoot({ MIXPANEL_PROJECT_TOKEN: TOKEN, MIXPANEL_REGION: 'eu' })), [[TOKEN, { region: 'EU', product: 'scalvs' }]]);
});

test('MIXPANEL=off wins over a token, and a bad region falls back to US', () => {
  assert.deepEqual(calls(mixpanelBoot({ MIXPANEL_PROJECT_TOKEN: TOKEN, MIXPANEL: 'off' })), []);
  assert.equal(calls(mixpanelBoot({ MIXPANEL_PROJECT_TOKEN: TOKEN, MIXPANEL_REGION: '"><script>' }))[0][1].region, 'US');
});

test('vendored SDK keeps autocapture, replay and IP geolocation off', () => {
  const init = readFileSync(new URL('../scripts/mixpanel-vendor/init.mjs', import.meta.url), 'utf8');
  for (const opt of ['autocapture: false', 'ip: false', 'record_sessions_percent: 0', 'track_marketing: false', 'flags: false', 'remote_settings_mode: "disabled"', 'track_pageview: false', 'mixpanel.track_pageview()', '"$current_url"']) {
    assert.ok(init.includes(opt), opt);
  }
  const vendor = readFileSync(new URL('../public/mixpanel.vendor.js', import.meta.url), 'utf8');
  assert.match(vendor, /initInfinitumMixpanel/);
  assert.match(vendor, /record_sessions_percent:0/);
});
