import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import catalogs from '../src/i18n/catalogs.js';
import { createI18n, LOCALES } from '../src/i18n/i18n.js';

const en = JSON.parse(readFileSync(new URL('../src/i18n/locales/en.json', import.meta.url)));

test('Russian is complete (ru.scalvs.app); other languages fall back to English per string', () => {
  const missing = Object.keys(en).filter((k) => !catalogs.ru?.[k]);
  assert.deepEqual(missing, []);
  for (const code of Object.keys(catalogs)) assert.ok(LOCALES.some((l) => l.code === code), `unknown catalog ${code}`);
});

test('translations keep their {n} placeholders', () => {
  for (const [code, cat] of Object.entries(catalogs)) {
    for (const [k, v] of Object.entries(cat)) {
      const ph = (s) => (s.match(/\{\d+\}/g) || []).sort().join();
      assert.equal(ph(v), ph(k), `${code}: ${k}`);
    }
  }
});

test('Arabic switches the page to right-to-left', () => {
  const i18n = createI18n({ catalogs: { ...catalogs, ar: catalogs.ar ?? { 'New task': 'x' } }, locale: 'ar', autoApply: false });
  assert.equal(i18n.dir, 'rtl');
});
