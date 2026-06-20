// Generates every app/web/PWA icon + favicon from the real AudioSilo silo mark.
//
// Single source of truth: the SVG path is read straight out of
// src/components/brand/logo.tsx (the same mark the in-app <Logo> draws), so the
// brand never drifts between the UI and the launcher/tab icons. Run with:
//   npm run gen:icons
// Requires `sharp` (devDependency) — it rasterises SVG with no system deps.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRIMARY = '#db2777';

// --- pull the mark out of logo.tsx ----------------------------------------
const logo = await readFile(resolve(root, 'src/components/brand/logo.tsx'), 'utf8');
const grab = (name) => {
  const m = new RegExp(`const ${name} =\\s*'([^']*)'`, 's').exec(logo);
  if (!m) throw new Error(`Could not find ${name} in logo.tsx`);
  return m[1];
};
const grabNum = (name) => {
  const m = new RegExp(`const ${name} =\\s*([0-9.]+)`).exec(logo);
  if (!m) throw new Error(`Could not find ${name} in logo.tsx`);
  return m[1];
};

const VIEW_BOX = grab('VIEW_BOX');
const PATH = grab('PATH');
const ROTATE = `rotate(180, ${grabNum('CENTER_X')}, ${grabNum('CENTER_Y')})`;

/** A square master SVG: optional solid bg + the mark centred with `pad` fraction
 * of breathing room (preserveAspectRatio keeps the landscape mark un-stretched). */
function master({ size = 512, bg = null, fill = PRIMARY, pad = 0.12 } = {}) {
  const inset = Math.round(size * pad);
  const box = size - inset * 2;
  const rect = bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    rect +
    `<svg x="${inset}" y="${inset}" width="${box}" height="${box}" viewBox="${VIEW_BOX}" preserveAspectRatio="xMidYMid meet">` +
    `<path d="${PATH}" fill="${fill}" transform="${ROTATE}"/>` +
    `</svg></svg>`
  );
}

async function emitSvg(rel, svg) {
  const out = resolve(root, rel);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, svg + '\n');
  console.log('svg ', rel);
}

async function emitPng(rel, opts, size) {
  const out = resolve(root, rel);
  await mkdir(dirname(out), { recursive: true });
  // The master SVG carries width/height = size, so sharp rasterises crisply at the
  // target resolution (no upscaling of a small raster).
  await sharp(Buffer.from(master({ ...opts, size })))
    .png()
    .toFile(out);
  console.log('png ', rel, `${size}²`);
}

// Icon recipes -------------------------------------------------------------
const appIcon = { bg: '#ffffff', pad: 0.12 }; // opaque (iOS requires it)
const maskable = { bg: '#ffffff', pad: 0.22 }; // extra safe-zone padding
const onBlue = { bg: null, fill: '#ffffff', pad: 0.26 }; // white mark over the splash blue
const adaptiveFg = { bg: null, pad: 0.28 }; // transparent; composited over the adaptive bg
const faviconOpts = { bg: null, pad: 0.06 }; // transparent, tight — reads well in a tab

// Committed master SVGs (handy reference / favicon source).
await emitSvg('assets/icon-src/icon.svg', master({ ...appIcon, size: 512 }));
await emitSvg('assets/icon-src/icon-maskable.svg', master({ ...maskable, size: 512 }));
await emitSvg('public/favicon.svg', master({ ...faviconOpts, size: 512 }));

// Native app assets.
await emitPng('assets/images/icon.png', appIcon, 1024);
await emitPng('assets/images/favicon.png', faviconOpts, 64);
await emitPng('assets/images/splash-icon.png', onBlue, 512);
await emitPng('assets/images/android-icon-foreground.png', adaptiveFg, 432);

// PWA icons (referenced by public/manifest.json).
await emitPng('public/icons/icon-192.png', appIcon, 192);
await emitPng('public/icons/icon-512.png', appIcon, 512);
await emitPng('public/icons/icon-512-maskable.png', maskable, 512);

console.log('\nDone. Re-run after changing the logo mark.');
