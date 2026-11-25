// The web export's start scripts, cut for a fast start (`metro.config.js` wraps Expo's
// serializer with `withWebStartChunks`). Web export only: the dev server, native bundles and
// a build with source maps are left exactly as Expo makes them.
//
// Why: the web player boots from about 4.5 MB of JavaScript (the shared `__common` chunk and
// the entry). V8 compiles a function the first time it runs, on the main thread, so a cold
// or warm start spent about 80 ms there before the first screen (Chrome keeps compiled code
// only for scripts a service worker caches at install; a page on plain http has no worker,
// and a browser's private window keeps no code cache at all). Two changes move that work
// off the main thread:
//
// 1. Every web script starts with V8's compile hint `//# allFunctionsCalledOnLoad` (Chrome
//    136+; other browsers read a comment): the script is compiled whole while it streams
//    in, on a background thread, instead of function by function as it runs.
// 2. A start script over `PART_CHARS` is cut into parts of about that size at module
//    boundaries (each `__d(...)` definition starts a line), each its own `<script defer>`
//    named `<name>-<n>-<hash of the part>.js`:
//    one big script compiles on one background thread, the parts on several at once.
//    Defer scripts run in document order, so the parts run as the whole did. Only the
//    scripts the HTML loads (`isAsync: false`); an async chunk is loaded by its name.
'use strict';

const { createHash } = require('node:crypto');
const vm = require('node:vm');

const { buildWorker } = require('./web-precache.cjs');

/** V8's explicit compile hint for a whole script (a comment to anything else). */
const COMPILE_HINT = '//# allFunctionsCalledOnLoad\n';

/** The size a start script is cut to (characters, about bytes: the code is minified). */
const PART_CHARS = 450_000;

/** The trailing `//# sourceMappingURL=` / `//# debugId=` comments: they name the whole.
 * Only at the end: the same line inside a module (a template literal) is code. */
const TRAILER = /(?:\n\/\/# (?:sourceMappingURL|debugId)=[^\n]*)+\n?$/;

/** Whether `code` is a complete script on its own (compiled, never run). */
function compiles(code) {
  try {
    new vm.Script(code);
    return true;
  } catch {
    return false;
  }
}

/**
 * `code` cut into about `parts` pieces, each a run of whole module definitions (a line
 * starting `__d(` opens one; what comes before the first stays with it, the run statements
 * after the last stay with that one). Every piece is a complete script: a boundary that is
 * not one after all (a line inside a template literal that starts `__d(`) is dropped and
 * its piece joined to the next, so the other boundaries keep the parallel compile. Null
 * when no cut into two or more complete scripts is left.
 */
function cutModules(code, parts) {
  // Where each module definition after the first line starts (just past its newline).
  const starts = [];
  for (let i = code.indexOf('\n__d('); i !== -1; i = code.indexOf('\n__d(', i + 1)) {
    starts.push(i + 1);
  }
  if (starts.length + 1 < parts) return null;
  const target = code.length / parts;
  const pieces = [];
  let from = 0;
  for (const at of starts) {
    if (pieces.length === parts - 1) break;
    if (at - from >= target) {
      pieces.push(code.slice(from, at));
      from = at;
    }
  }
  pieces.push(code.slice(from));
  const whole = [];
  let carried = '';
  for (const p of pieces) {
    const piece = carried + p;
    if (compiles(piece)) {
      whole.push(piece);
      carried = '';
    } else carried = piece;
  }
  // What is left over joins the last complete piece, which must still be one.
  if (carried) {
    if (whole.length === 0 || !compiles(whole[whole.length - 1] + carried)) return null;
    whole[whole.length - 1] += carried;
  }
  return whole.length > 1 ? whole : null;
}

/**
 * A part's file name: `<name>-<n>-<hash>.js` (n from 1, `hash` of the part's own source).
 * The whole's name hashes its code, not the cut: a cut that changes on its own (another
 * `PART_CHARS`, another rule, the hint) must not reuse a part's name, since the build's
 * files are cached as immutable (by the browser and the service worker), and an old part
 * beside a new one would leave modules out (or the entry's run statements).
 */
function partName(filename, n, source) {
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
  return filename.replace(/\.js$/, `-${n}-${hash}.js`);
}

/**
 * The serializer's web assets with the start cut for speed (see the file's head): each JS
 * asset with the compile hint, each start script over `partChars` in parts, chained by
 * `requires` so the HTML names them in order and whatever required the whole requires its
 * last part. Untouched when the export carries source maps (they would no longer match).
 */
function splitStartScripts(assets, partChars = PART_CHARS) {
  if (assets.some((a) => a.type === 'map')) return assets;
  const renamed = new Map(); // a cut script's name -> its last part's
  const out = [];
  for (const asset of assets) {
    if (asset.type !== 'js') {
      out.push(asset);
      continue;
    }
    const code = asset.source.replace(TRAILER, '');
    const count = Math.ceil(code.length / partChars);
    const pieces = !asset.metadata.isAsync && count > 1 ? cutModules(code, count) : null;
    if (!pieces) {
      out.push({ ...asset, source: COMPILE_HINT + code });
      continue;
    }
    let requires = asset.metadata.requires;
    pieces.forEach((piece, i) => {
      const source = COMPILE_HINT + piece;
      const filename = partName(asset.filename, i + 1, source);
      out.push({ ...asset, filename, metadata: { ...asset.metadata, requires }, source });
      requires = [filename];
    });
    renamed.set(asset.filename, requires[0]);
  }
  if (renamed.size === 0) return out;
  return out.map((asset) =>
    asset.type === 'js' && asset.metadata.requires?.some((r) => renamed.has(r))
      ? {
          ...asset,
          metadata: {
            ...asset.metadata,
            requires: asset.metadata.requires.map((r) => renamed.get(r) ?? r),
          },
        }
      : asset,
  );
}

/** Whether a serializer answer is the web export's client build: `{ artifacts, assets }`
 * (the dev server gets a string back), for the web, not in dev, and not the static
 * render's server bundle. */
function isWebExport(result, graph) {
  const t = graph?.transformOptions;
  const env = t?.customTransformOptions?.environment;
  return (
    Array.isArray(result?.artifacts) &&
    t?.platform === 'web' &&
    !t.dev &&
    env !== 'node' &&
    env !== 'react-server'
  );
}

/** `config` with its serializer's web export cut for a fast start (`splitStartScripts`). */
function withWebStartChunks(config) {
  const serialize = config.serializer?.customSerializer;
  if (!serialize) return config;
  const wrapped = async (entryPoint, preModules, graph, options) => {
    const result = await serialize(entryPoint, preModules, graph, options);
    if (!isWebExport(result, graph)) return result;
    const artifacts = splitStartScripts(result.artifacts);
    return { ...result, artifacts: [...artifacts, buildWorker(artifacts, result.assets)] };
  };
  // Keep the markers Expo reads off its own serializer.
  config.serializer.customSerializer = Object.assign(wrapped, serialize);
  return config;
}

module.exports = {
  COMPILE_HINT,
  isWebExport,
  cutModules,
  splitStartScripts,
  withWebStartChunks,
};
