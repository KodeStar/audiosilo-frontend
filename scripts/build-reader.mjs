#!/usr/bin/env node
// Builds the ebook reader document (Bridge Phase 3b): reader/src + the vendored foliate-js
// -> public/reader.html, ONE self-contained page (an inline script and style, no
// subresources), which the web export copies to dist/reader.html and the server serves as
// /web/reader.html under its own CSP (it hashes the inline script itself).
//
//   node scripts/build-reader.mjs           write public/reader.html
//   node scripts/build-reader.mjs --check   fail when public/reader.html is not what the
//                                           sources build (`npm run reader:check`, in `npm test`)
//
// The page carries the whole policy as a meta CSP too, with the script's sha256, so it is
// safe wherever it is loaded. `frame-ancestors` cannot be set from a meta tag: the server
// sends it. The vendored foliate-js must be byte for byte the pinned upstream files
// (reader/vendor/FOLIATE_PIN.txt holds their sha256): the build refuses an edited copy.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readerDir = join(root, 'reader');
const vendorDir = join(readerDir, 'vendor', 'foliate-js');
const out = join(root, 'public', 'reader.html');

const sha256 = (data, encoding) => createHash('sha256').update(data).digest(encoding);

/** Every vendored file listed in FOLIATE_PIN.txt, with the digest it must have. */
function checkVendor() {
  const pin = readFileSync(join(readerDir, 'vendor', 'FOLIATE_PIN.txt'), 'utf8');
  const files = [...pin.matchAll(/^([0-9a-f]{64}) {2}(\S+)$/gm)];
  if (!/^commit [0-9a-f]{40}$/m.test(pin) || files.length === 0) {
    throw new Error('reader/vendor/FOLIATE_PIN.txt: no commit or no files');
  }
  for (const [, digest, file] of files) {
    if (sha256(readFileSync(join(vendorDir, file)), 'hex') !== digest) {
      throw new Error(`reader/vendor/foliate-js/${file} differs from the pinned upstream file`);
    }
  }
}

// foliate's View imports every format and feature lazily; the reader opens EPUB only, so
// the rest never enters the bundle. Each becomes a module that refuses to load.
const EXCLUDED = /\/(pdf|mobi|fb2|comic-book|tts|search|vendor\/fflate)\.js$/;
const excludePlugin = {
  name: 'exclude',
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (a) =>
      EXCLUDED.test(a.path) ? { path: a.path, namespace: 'excluded' } : null,
    );
    b.onLoad({ filter: /.*/, namespace: 'excluded' }, (a) => ({
      contents: `throw new Error(${JSON.stringify(`${a.path} is not part of the reader`)});`,
      loader: 'js',
    }));
  },
};

const BANNER = `/*! AudioSilo reader. Bundles foliate-js (MIT, Copyright (c) 2022 John Factotum) and
zip.js (BSD-3-Clause, Copyright (c) 2023 Gildas Lormeau); their notices are in reader/vendor of
https://github.com/KodeStar/audiosilo-frontend */`;

async function bundle() {
  const result = await build({
    entryPoints: [join(readerDir, 'src', 'reader.js')],
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: true,
    write: false,
    legalComments: 'none',
    banner: { js: BANNER },
    charset: 'utf8',
    logLevel: 'warning',
    plugins: [excludePlugin],
  });
  return result.outputFiles[0].text;
}

/** The reader's policy (READ-ALONG-RESEARCH "Reader recipe"), minus `frame-ancestors`. */
function readerPolicy(scriptHash) {
  return [
    "default-src 'none'",
    `script-src 'sha256-${scriptHash}'`,
    "style-src 'unsafe-inline' blob:",
    'img-src blob: data:',
    'font-src blob: data:',
    'frame-src blob:',
    "media-src 'none'",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

async function render() {
  checkVendor();
  // A `</script` inside the bundle would end the element early.
  const js = (await bundle()).trim().replace(/<\/script/gi, '<\\/script');
  const css = readFileSync(join(readerDir, 'src', 'reader.css'), 'utf8').trim();
  const template = readFileSync(join(readerDir, 'src', 'reader.html'), 'utf8');
  const html = template
    .replace(/<style>\s*__CSS__\s*<\/style>/, () => `<style>${css}</style>`)
    .replace(/<script>\s*__SCRIPT__;?\s*<\/script>/, () => `<script>${js}</script>`)
    .replace('__CSP__', () => readerPolicy(sha256(js, 'base64')));
  if (/__(CSS|SCRIPT|CSP)__/.test(html)) throw new Error('reader.html: a placeholder was left');
  return html;
}

const html = await render();
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(out, 'utf8');
  } catch {
    // missing: reported below
  }
  if (current !== html) {
    console.error('public/reader.html is out of date: run `npm run reader:build` and commit it.');
    process.exit(1);
  }
  console.log('public/reader.html is up to date.');
} else {
  writeFileSync(out, html);
  console.log(`public/reader.html: ${(html.length / 1024).toFixed(0)} KB`);
}
