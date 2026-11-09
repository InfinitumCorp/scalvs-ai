# SCALVS.ai interface language

The UI follows the visitor's language and falls back to English. A choice made in the sidebar menu is remembered in `localStorage["infinitum.lang"]`, a key shared by every Infinitum app. `?lang=ru` also works. Arabic switches the page to right to left.

- `i18n.js`, `i18n.css`: the runtime, vendored unchanged from infinitum-nexus `packages/i18n`.
- `locales/en.json`: the English strings, extracted from `index.html` and `src/`. The keys are the English text.
- `locales/<lang>.json`: translations generated at build time by open-weight models through `@infinitum/ai`, with OmniRoute first.
- `catalogs.js`: the bundle the app imports. It holds only languages with at least 80% coverage. Missing strings show in English.

There are no runtime translation calls, so the UI works offline and on the ru.scalvs.app mirror. User content (tasks, agent output, forecast reports) is marked `translate="no"`.

Regenerate from an infinitum-nexus checkout:

```bash
node --experimental-strip-types ../infinitum-nexus/packages/i18n/scripts/extract.ts --out src/i18n/locales index.html src
node --experimental-strip-types ../infinitum-nexus/packages/i18n/scripts/translate.ts --dir src/i18n/locales --bundle src/i18n/catalogs.js
```
