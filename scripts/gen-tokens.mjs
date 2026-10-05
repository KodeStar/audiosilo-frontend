// Generates the app's colour tokens from their one source, src/theme/tokens.json:
//   - the `@theme` colour block inside src/global.css (between the generated-region
//     markers; everything outside them is hand-written and left alone), which
//     Tailwind/Uniwind turn into `bg-*`/`text-*`/`border-*` utilities, and
//   - src/theme/tokens.ts, the raw `colors` values for native props.
//
//   npm run gen:tokens                      # rewrite both outputs
//   node scripts/gen-tokens.mjs --check     # exit 1 if either is stale (no writes)
//
// `npm test` (and so CI) runs `--check` before jest, so drift between the JSON and the
// checked-in outputs fails the standard gate. The generated region and tokens.ts go
// through Prettier (the repo's own config) so they are already `format`-clean; the
// hand-written CSS around the region is kept byte for byte, so `--check` reports token
// drift only (formatting is `npm run format`'s job).

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as prettier from 'prettier';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(root, 'src/theme/tokens.json');
const CSS_OUT = resolve(root, 'src/global.css');
const TS_OUT = resolve(root, 'src/theme/tokens.ts');

const REGEN = '`npm run gen:tokens`';
const START_TAG = '/* @generated-tokens:start';
const CSS_START = `${START_TAG} - DO NOT EDIT this region. Source: src/theme/tokens.json; regenerate with ${REGEN}. */`;
const CSS_END = '/* @generated-tokens:end */';

const HEX = /^#[0-9a-f]{6}$/i;

/** An object's keys minus `$`-prefixed annotations (`$comment`), at any level. */
const keysOf = (obj) => Object.keys(obj).filter((k) => !k.startsWith('$'));

/** Shade keys in display order: DEFAULT first, then numeric (50, 100, ..., 750, 800, 840, ...). */
const shadeKeys = (family) =>
  keysOf(family).sort((a, b) =>
    a === 'DEFAULT' ? -1 : b === 'DEFAULT' ? 1 : Number(a) - Number(b),
  );

/** Flattens the palette to `{ 'primary': hex, 'primary-50': hex, 'white': hex, ... }`. */
function flattenPalette(palette) {
  const raw = {};
  for (const name of keysOf(palette)) {
    const value = palette[name];
    if (typeof value === 'string') {
      raw[name] = value;
      continue;
    }
    for (const shade of shadeKeys(value)) {
      raw[shade === 'DEFAULT' ? name : `${name}-${shade}`] = value[shade];
    }
  }
  // A shade may alias another shade's hex value ("red-500"), one level deep.
  const hex = (key) => {
    const v = HEX.test(raw[key]) ? raw[key] : raw[raw[key]];
    if (!HEX.test(v ?? ''))
      throw new Error(`tokens.json: "${key}" is not a hex colour or an alias of one`);
    return v.toLowerCase();
  };
  return Object.fromEntries(Object.keys(raw).map((k) => [k, hex(k)]));
}

async function render() {
  const tokens = JSON.parse(await readFile(SOURCE, 'utf8'));
  const flat = flattenPalette(tokens.palette);
  const hexOf = (ref) => {
    if (!Object.hasOwn(flat, ref))
      throw new Error(`tokens.json: semantic token names unknown colour "${ref}"`);
    return flat[ref];
  };
  const { light, dark } = tokens.semantic;
  if (keysOf(light).join() !== keysOf(dark).join()) {
    throw new Error('tokens.json: semantic.light and semantic.dark must have the same keys');
  }
  const fmt = async (text, filepath) =>
    prettier.format(text, { ...(await prettier.resolveConfig(filepath)), filepath });

  // --- src/global.css region (only the region is generated and formatted) -------------
  const themeLines = Object.entries(flat).map(([k, hex]) => `  --color-${k}: ${hex};`);
  const cssRegion = (
    await fmt([CSS_START, '@theme {', ...themeLines, '}', CSS_END].join('\n'), CSS_OUT)
  ).trimEnd();

  const currentCss = await readFile(CSS_OUT, 'utf8');
  const start = currentCss.indexOf(START_TAG);
  const end = currentCss.indexOf(CSS_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${relative(root, CSS_OUT)}: generated-region markers not found`);
  }
  const css = currentCss.slice(0, start) + cssRegion + currentCss.slice(end + CSS_END.length);

  // --- src/theme/tokens.ts -------------------------------------------------------------
  const entry = (key, spec, indent) => {
    const { ref, note } = typeof spec === 'string' ? { ref: spec, note: undefined } : spec;
    const lines = [];
    if (note) lines.push(`${indent}/** ${note} */`);
    lines.push(`${indent}${key}: '${hexOf(ref)}', // ${ref}`);
    return lines;
  };
  const body = [];
  for (const key of keysOf(tokens.semantic)) {
    const spec = tokens.semantic[key];
    if (typeof spec === 'object' && !('ref' in spec)) {
      body.push(`  ${key}: {`);
      for (const k of keysOf(spec)) body.push(...entry(k, spec[k], '    '));
      body.push('  },');
    } else {
      body.push(...entry(key, spec, '  '));
    }
  }
  const intro = tokens.semantic.$comment ? `${tokens.semantic.$comment} ` : '';
  const ts = [
    `// GENERATED FILE - DO NOT EDIT. Source: src/theme/tokens.json; regenerate with ${REGEN}.`,
    '',
    `/** ${intro}The same palette backs the Tailwind classes (src/global.css). */`,
    'export const colors = {',
    ...body,
    '} as const;',
    '',
  ].join('\n');

  return { css, ts: await fmt(ts, TS_OUT) };
}

{
  const check = process.argv.includes('--check');
  const { css, ts } = await render();
  const outputs = [
    [CSS_OUT, css],
    [TS_OUT, ts],
  ];
  const stale = [];
  for (const [file, next] of outputs) {
    const current = await readFile(file, 'utf8');
    if (current === next) continue;
    if (check) stale.push(relative(root, file));
    else await writeFile(file, next);
  }
  if (stale.length) {
    console.error(
      `Colour tokens are out of date with src/theme/tokens.json: ${stale.join(', ')}.\nRun ${REGEN} and commit the result.`,
    );
    process.exit(1);
  }
  if (!check) console.log('Colour tokens regenerated from src/theme/tokens.json.');
}
