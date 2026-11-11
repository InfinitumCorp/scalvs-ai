// Builds the source images @capacitor/assets expects (assets/*.png) from the
// SCALVS.ai mark "@S™" (brand/icon.svg and brand/glyph.svg, made by make-glyph.mjs):
// Arial Regular, ink #111820 on white.
import sharp from 'sharp';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = new URL('../assets/', import.meta.url);
const p = (name) => fileURLToPath(new URL(name, out));
mkdirSync(out, { recursive: true });
const brand = (name) => readFileSync(new URL(`../brand/${name}`, import.meta.url));
const white = { r: 255, g: 255, b: 255, alpha: 1 };
const render = (svg, px) => sharp(svg, { density: 300 }).resize(px, px);

// Full icon (iOS and legacy Android).
await render(brand('icon.svg'), 1024).png().toFile(p('icon-only.png'));
// Android adaptive icon: the mark stays inside the safe zone on a white layer.
await render(brand('glyph.svg'), 1024).png().toFile(p('icon-foreground.png'));
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: white } }).png().toFile(p('icon-background.png'));
// Splash: the mark centred on white.
const mark = await render(brand('glyph.svg'), 900).png().toBuffer();
for (const name of ['splash.png', 'splash-dark.png']) {
  await sharp({ create: { width: 2732, height: 2732, channels: 4, background: white } })
    .composite([{ input: mark, gravity: 'center' }]).png().toFile(p(name));
}
console.log('assets/ ready');
