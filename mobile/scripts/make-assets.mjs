// Builds the source images @capacitor/assets expects (assets/*.png) from the
// web app's icons, so the phone app always matches scalvs.app.
import sharp from 'sharp';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const p = (name) => fileURLToPath(new URL(name, out));

const icons = new URL('../../public/icons/', import.meta.url);
const out = new URL('../assets/', import.meta.url);
mkdirSync(out, { recursive: true });
const white = { r: 255, g: 255, b: 255, alpha: 1 };

// Full icon (iOS and legacy Android).
const icon = fileURLToPath(new URL('icon-1024.png', icons));
await sharp(icon).resize(1024, 1024).png().toFile(p('icon-only.png'));
// Android adaptive icon: the maskable artwork keeps the frame inside the safe zone.
await sharp(readFileSync(new URL('maskable.svg', icons))).resize(1024, 1024).png().toFile(p('icon-foreground.png'));
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: white } }).png().toFile(p('icon-background.png'));
// Splash: icon centred on white.
const mark = await sharp(icon).resize(600, 600).png().toBuffer();
for (const name of ['splash.png', 'splash-dark.png']) {
  await sharp({ create: { width: 2732, height: 2732, channels: 4, background: white } })
    .composite([{ input: mark, gravity: 'center' }]).png().toFile(p(name));
}
console.log('assets/ ready');
