// node --test scripts/web-start-chunks.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  COMPILE_HINT,
  cutModules,
  isWebExport,
  splitStartScripts,
  withWebStartChunks,
} = require('./web-start-chunks.cjs');

/** A Metro-like script: a preamble, `n` module definitions (one per line), a run call. */
function bundle(n, size = 40) {
  const mods = Array.from(
    { length: n },
    (_, i) => `__d(function(g,r,i,a,m,e,d){e.v${i}="${'x'.repeat(size)}"},${i},[]);`,
  );
  return ['var __pre=1;', ...mods, '__r(0);'].join('\n');
}

const js = (filename, source, metadata = {}) => ({
  filename,
  type: 'js',
  metadata: { isAsync: false, requires: [], ...metadata },
  source,
});

test('cutModules: whole module definitions, in order, each a complete script', () => {
  const code = bundle(9);
  const pieces = cutModules(code, 3);
  assert.equal(pieces.length, 3);
  assert.equal(pieces.join(''), code);
  assert.ok(pieces[0].startsWith('var __pre=1;\n__d('));
  for (const p of pieces.slice(1)) assert.ok(p.startsWith('__d('));
  assert.ok(pieces[2].endsWith('__r(0);'));
});

test('cutModules: null when a cut would not be a complete script, or too few modules', () => {
  // A template literal holding a line that looks like a module start.
  const code = `var t=\`${'y'.repeat(500)}\n__d(oops\`;\n` + bundle(2);
  assert.equal(cutModules(code, 3), null);
  assert.equal(cutModules(bundle(2), 5), null);
});

test('splitStartScripts: a big start script in parts, chained, its dependents renamed', () => {
  const common = js('_expo/static/js/web/__common-abc.js', bundle(30) + '\n//# debugId=x');
  const entry = js('_expo/static/js/web/index-def.js', bundle(2), {
    requires: ['_expo/static/js/web/__common-abc.js'],
  });
  const css = { filename: 'g.css', type: 'css', metadata: {}, source: 'a{}' };
  const out = splitStartScripts([common, css, entry], 600);
  const names = out.map((a) => a.filename);
  const parts = names.filter((n) => n.includes('__common-abc-'));
  assert.ok(parts.length > 1);
  parts.forEach((name, i) =>
    assert.match(name, new RegExp(`^_expo/static/js/web/__common-abc-${i + 1}-[0-9a-f]{12}\\.js$`)),
  );
  const byName = new Map(out.map((a) => [a.filename, a]));
  assert.deepEqual(byName.get(parts[0]).metadata.requires, []);
  for (let i = 1; i < parts.length; i++)
    assert.deepEqual(byName.get(parts[i]).metadata.requires, [parts[i - 1]]);
  // The entry now waits for the last part (the HTML orders scripts by `requires`).
  assert.deepEqual(byName.get('_expo/static/js/web/index-def.js').metadata.requires, [
    parts.at(-1),
  ]);
  // Every script carries the compile hint; the parts add up to the whole, minus its trailer.
  for (const a of out.filter((x) => x.type === 'js')) assert.ok(a.source.startsWith(COMPILE_HINT));
  assert.equal(
    parts.map((n) => byName.get(n).source.slice(COMPILE_HINT.length)).join(''),
    bundle(30),
  );
  assert.equal(byName.get('g.css'), css);
});

test('splitStartScripts: a part is named after its own source, so another cut never reuses a name', () => {
  const common = js('_expo/static/js/web/__common-abc.js', bundle(30));
  const first = (partChars) => splitStartScripts([common], partChars)[0].filename;
  assert.notEqual(first(600), first(900));
  assert.equal(first(600), first(600));
});

test('splitStartScripts: only the trailing comments go, never the same line inside the code', () => {
  const inner = 'var t=`a\n//# sourceMappingURL=b.js\n`;\n';
  const chunk = js('_expo/static/js/web/route-1.js', inner + bundle(2) + '\n//# debugId=x\n', {
    isAsync: true,
  });
  assert.equal(splitStartScripts([chunk], 600)[0].source, COMPILE_HINT + inner + bundle(2));
});

test('splitStartScripts: an async chunk keeps its name (it is loaded by it), hint only', () => {
  const chunk = js('_expo/static/js/web/route-1.js', bundle(30), { isAsync: true });
  const out = splitStartScripts([chunk], 600);
  assert.equal(out.length, 1);
  assert.equal(out[0].filename, chunk.filename);
  assert.equal(out[0].source, COMPILE_HINT + bundle(30));
});

test('splitStartScripts: an export with source maps is left as it is', () => {
  const assets = [
    js('a.js', bundle(30)),
    { filename: 'a.js.map', type: 'map', metadata: {}, source: '{}' },
  ];
  assert.equal(splitStartScripts(assets, 600), assets);
});

test('isWebExport: only the web export client build', () => {
  const web = { transformOptions: { platform: 'web', dev: false } };
  const out = { artifacts: [], assets: [] };
  assert.equal(isWebExport(out, web), true);
  assert.equal(isWebExport('{"artifacts":[]}', web), false); // the dev server
  assert.equal(isWebExport(out, { transformOptions: { platform: 'ios', dev: false } }), false);
  assert.equal(isWebExport(out, { transformOptions: { platform: 'web', dev: true } }), false);
  const node = { platform: 'web', dev: false, customTransformOptions: { environment: 'node' } };
  assert.equal(isWebExport(out, { transformOptions: node }), false);
});

test('withWebStartChunks: wraps the serializer, keeps its markers, passes others through', async () => {
  const big = js('_expo/static/js/web/__common-x.js', bundle(2000));
  const inner = Object.assign(
    async (_e, _p, graph) =>
      graph.transformOptions.platform === 'web' ? { artifacts: [big], assets: [] } : 'native code',
    { __originalSerializer: null },
  );
  const config = withWebStartChunks({ serializer: { customSerializer: inner } });
  const serialize = config.serializer.customSerializer;
  assert.ok('__originalSerializer' in serialize);
  const web = await serialize('e', [], { transformOptions: { platform: 'web', dev: false } }, {});
  assert.ok(web.artifacts.every((a) => a.source.startsWith(COMPILE_HINT)));
  const native = await serialize(
    'e',
    [],
    { transformOptions: { platform: 'ios', dev: false } },
    {},
  );
  assert.equal(native, 'native code');
});
