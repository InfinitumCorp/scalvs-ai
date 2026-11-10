// UI language for SCALVS.ai. Catalogs are generated at build time (no runtime
// translation calls), so this works offline and on the ru.scalvs.app mirror.
// i18n.js is vendored from infinitum-nexus packages/i18n; regenerate catalogs with
// that package's extract.ts + translate.ts (see src/i18n/README.md).
import { startI18n } from './i18n.js';
import catalogs from './catalogs.js';

export const i18n = startI18n({ catalogs, switcher: '#lang-switch' });
export const t = i18n.t;
