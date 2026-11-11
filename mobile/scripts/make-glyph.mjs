// Builds the SCALVS.ai mark "@S™" in the brand font (Arial Regular, ink #111820)
// as plain SVG outlines, so no font is needed to render it later.
//   node scripts/make-glyph.mjs [path/to/arial.ttf]
// Writes brand/glyph.svg (mark only, transparent) and brand/icon.svg (mark on a white tile).
import opentype from 'opentype.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fontFile = process.argv[2] || 'C:/Windows/Fonts/arial.ttf';
const font = opentype.loadSync(fontFile);
const INK = '#111820';
const SIZE = 1024;

// "@S" at 1000 units; "™" at 38% of that, top-aligned with the S and set just after it.
const main = font.getPath('@S', 0, 0, 1000);
const mb = main.getBoundingBox();
const tmSize = 380;
const tmProbe = font.getPath('™', 0, 0, tmSize).getBoundingBox();
const tmX = mb.x2 + 30 - tmProbe.x1;
const tmY = mb.y1 - tmProbe.y1;
const tm = font.getPath('™', tmX, tmY, tmSize);
const tb = tm.getBoundingBox();
const box = { x1: Math.min(mb.x1, tb.x1), y1: Math.min(mb.y1, tb.y1), x2: Math.max(mb.x2, tb.x2), y2: Math.max(mb.y2, tb.y2) };

// Fit the mark to `width` px, centred on a SIZE x SIZE canvas.
function mark(width) {
  const s = width / (box.x2 - box.x1);
  const h = (box.y2 - box.y1) * s;
  const tx = (SIZE - width) / 2 - box.x1 * s;
  const ty = (SIZE - h) / 2 - box.y1 * s;
  const d = main.toPathData(2) + tm.toPathData(2);
  return `<path transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(5)})" d="${d}" fill="${INK}"/>`;
}

const out = new URL('../brand/', import.meta.url);
mkdirSync(out, { recursive: true });
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">${body}</svg>\n`;
// Full icon: the mark spans 72% of the tile. Adaptive foreground: 64%, inside the 66% safe zone.
writeFileSync(fileURLToPath(new URL('icon.svg', out)), svg(`<rect width="${SIZE}" height="${SIZE}" fill="#FFFFFF"/>${mark(SIZE * 0.72)}`));
writeFileSync(fileURLToPath(new URL('glyph.svg', out)), svg(mark(SIZE * 0.64)));
console.log('brand/icon.svg and brand/glyph.svg ready');
