#!/usr/bin/env node
// Builds the ebook reader document (Bridge Phase 3b): reader/src + the vendored foliate-js
// -> ONE self-contained page (an inline script and style, no subresources), in two variants:
//
// - web: public/reader.html, which the web export copies to dist/reader.html and the server
//   serves as /web/reader.html under its own CSP (it hashes the inline script itself);
// - native: src/reader/reader-html.native.ts, a string module the app loads as a WebView's
//   HTML source (Phase 3b-2). The same policy: the host posts the EPUB in base64 chunks,
//   so the page needs no network and no file access.
//
//   node scripts/build-reader.mjs           write both
//   node scripts/build-reader.mjs --check   fail when either is not what the sources build
//                                           (`npm run reader:check`, in `npm test`)
//
// Each page carries the whole policy as a meta CSP, with the script's sha256, so it is
// safe wherever it is loaded. `frame-ancestors` cannot be set from a meta tag: the server
// sends it for the web variant (a WebView document has no ancestors). The vendored foliate-js must be byte for byte the pinned upstream files
// (reader/vendor/FOLIATE_PIN.txt holds their sha256): the build refuses an edited copy.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readerDir = join(root, 'reader');
const vendorDir = join(readerDir, 'vendor', 'foliate-js');
const webOut = join(root, 'public', 'reader.html');
const nativeOut = join(root, 'src', 'reader', 'reader-html.native.ts');

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

async function bundle(native) {
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
    define: { __NATIVE__: String(native) },
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

async function render(native) {
  // A `</script` inside the bundle would end the element early.
  const js = (await bundle(native)).trim().replace(/<\/script/gi, '<\\/script');
  const css = readFileSync(join(readerDir, 'src', 'reader.css'), 'utf8').trim();
  const template = readFileSync(join(readerDir, 'src', 'reader.html'), 'utf8');
  const html = template
    .replace(/<style>\s*__CSS__\s*<\/style>/, () => `<style>${css}</style>`)
    .replace(/<script>\s*__SCRIPT__;?\s*<\/script>/, () => `<script>${js}</script>`)
    .replace('__CSP__', () => readerPolicy(sha256(js, 'base64')));
  if (/__(CSS|SCRIPT|CSP)__/.test(html)) throw new Error('reader.html: a placeholder was left');
  return html;
}

/** The native variant as a TypeScript string module. */
function nativeModule(html) {
  return `// Generated by scripts/build-reader.mjs (\`npm run reader:build\`): do not edit.
// The native reader document (Bridge Phase 3b-2): reader/src built with __NATIVE__, loaded as
// the reader WebView's HTML source (src/reader/reader-host.native.tsx).
export const READER_HTML = ${JSON.stringify(html)};
`;
}

checkVendor();
const outputs = [
  [webOut, 'public/reader.html', await render(false)],
  [nativeOut, 'src/reader/reader-html.native.ts', nativeModule(await render(true))],
];
if (process.argv.includes('--check')) {
  let stale = false;
  for (const [file, name, content] of outputs) {
    let current = '';
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      // missing: reported below
    }
    if (current !== content) {
      console.error(`${name} is out of date: run \`npm run reader:build\` and commit it.`);
      stale = true;
    }
  }
  if (stale) process.exit(1);
  console.log('The reader documents are up to date.');
} else {
  for (const [file, name, content] of outputs) {
    writeFileSync(file, content);
    console.log(`${name}: ${(content.length / 1024).toFixed(0)} KB`);
  }
}
