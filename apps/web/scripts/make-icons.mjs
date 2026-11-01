// Regenerate PWA icons from the SVG mark: node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const mark = (size, inset, radius) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="${radius}" fill="#111214"/>
  <g transform="translate(${inset} ${inset}) scale(${(64 - 2 * inset) / 64})"
     fill="none" stroke="#8fc4b0" stroke-width="4" stroke-linecap="round">
    <path d="M14 38v-12"/><path d="M23 46V18"/><path d="M32 52V12"/><path d="M41 44V20"/><path d="M50 36V28"/>
  </g>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, size, inset, radius] of [
  ['icon-192.png', 192, 0, 14],
  ['icon-512.png', 512, 0, 14],
  ['icon-maskable-512.png', 512, 10, 0], // glyph inside the 80% safe zone, full-bleed background
]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0;background:transparent">${mark(size, inset, radius)}</body>`);
  writeFileSync(new URL(`../public/${file}`, import.meta.url), await page.locator('svg').screenshot({ omitBackground: true }));
  console.log('wrote', file);
}
// Android legacy launcher icons (pre-Android 8; newer devices use the adaptive vector icon).
const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [density, size] of Object.entries(densities)) {
  for (const [file, radius] of [['ic_launcher.png', 14], ['ic_launcher_round.png', 32]]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<body style="margin:0;background:transparent">${mark(size, 6, radius)}</body>`);
    const out = new URL(`../android/app/src/main/res/mipmap-${density}/${file}`, import.meta.url);
    writeFileSync(out, await page.locator('svg').screenshot({ omitBackground: true }));
  }
  console.log('wrote android mipmap-' + density);
}
await browser.close();
