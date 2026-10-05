// Generates the app's colour tokens from their one source, src/theme/tokens.json:
//   - the `@theme` colour block inside src/global.css (between the generated-region
//     markers; everything outside them is hand-written and left alone), which
//     Tailwind/Uniwind turn into `bg-*`/`text-*`/`border-*` utilities, and
//   - src/theme/tokens.ts, the raw `colors` values for native props.
//
//   npm run gen:tokens                      # rewrite both outputs
//   node scripts/gen-tokens.mjs --check     # exit 1 if either is stale (no writes)
//
// `--check` is what the drift test (src/theme/tokens.test.ts) runs, so `npm test`
// and CI fail when the JSON and the checked-in outputs disagree. Output goes through
// Prettier (the repo's own config) so a regenerated file is already `format`-clean.

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

/** Word-wraps prose into JSDoc lines (` * ...`) at `indent`, within the 100-column print width. */
const jsdoc = (text, indent) => {
  const lines = [''];
  for (const word of text.split(/\s+/)) {
    const line = lines[lines.length - 1];
    if (line && indent.length + 3 + line.length + 1 + word.length > 92) lines.push(word);
    else lines[lines.length - 1] = line ? `${line} ${word}` : word;
  }
  return [`${indent}/**`, ...lines.map((l) => `${indent} * ${l}`), `${indent} */`];
};

/** Shade keys in display order: DEFAULT first, then numeric (50, 100, ..., 750, 800, 840, ...). */
const shadeKeys = (family) =>
  Object.keys(family)
    .filter((k) => !k.startsWith('$'))
    .sort((a, b) => (a === 'DEFAULT' ? -1 : b === 'DEFAULT' ? 1 : Number(a) - Number(b)));

/** Flattens the palette to `{ 'primary': hex, 'primary-50': hex, 'white': hex, ... }`. */
function flattenPalette(palette) {
  const raw = {};
  for (const [name, value] of Object.entries(palette)) {
    if (name.startsWith('$')) continue;
    if (typeof value === 'string') {
      raw[name] = value;
      continue;
    }
    for (const shade of shadeKeys(value)) {
      raw[shade === 'DEFAULT' ? name : `${name}-${shade}`] = value[shade];
    }
  }
  // A shade may name another shade ("red-500") instead of a hex value.
  const resolveRef = (key, seen = []) => {
    const v = raw[key];
    if (v === undefined) throw new Error(`tokens.json: unknown colour "${key}"`);
    if (HEX.test(v)) return v.toLowerCase();
    if (seen.includes(v)) throw new Error(`tokens.json: circular reference ${[...seen, v]}`);
    return resolveRef(v, [...seen, key]);
  };
  return Object.fromEntries(Object.keys(raw).map((k) => [k, resolveRef(k)]));
}

export async function render() {
  const tokens = JSON.parse(await readFile(SOURCE, 'utf8'));
  const flat = flattenPalette(tokens.palette);
  const hexOf = (ref) => {
    if (!(ref in flat))
      throw new Error(`tokens.json: semantic token names unknown colour "${ref}"`);
    return flat[ref];
  };

  // --- src/global.css region ----------------------------------------------------------
  const themeLines = Object.entries(flat).map(([k, hex]) => `  --color-${k}: ${hex};`);
  const cssRegion = [CSS_START, '@theme {', ...themeLines, '}', CSS_END].join('\n');

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
    if (note) lines.push(...jsdoc(note, indent));
    lines.push(`${indent}${key}: '${hexOf(ref)}', // ${ref}`);
    return lines;
  };
  const body = [];
  for (const [key, spec] of Object.entries(tokens.semantic)) {
    if (key.startsWith('$')) continue;
    if (typeof spec === 'object' && !('ref' in spec)) {
      body.push(`  ${key}: {`);
      for (const [k, v] of Object.entries(spec)) body.push(...entry(k, v, '    '));
      body.push('  },');
    } else {
      body.push(...entry(key, spec, '  '));
    }
  }
  const ts = [
    `// GENERATED FILE - DO NOT EDIT. Source: src/theme/tokens.json; regenerate with ${REGEN}.`,
    '',
    ...jsdoc(
      `${tokens.semantic.$comment} The same palette backs the Tailwind classes (the @theme block in src/global.css).`,
      '',
    ),
    'export const colors = {',
    ...body,
    '} as const;',
    '',
    "export { tabularNums } from './tabular-nums';",
    '',
  ].join('\n');

  const fmt = async (text, filepath) =>
    prettier.format(text, { ...(await prettier.resolveConfig(filepath)), filepath });
  return { css: await fmt(css, CSS_OUT), ts: await fmt(ts, TS_OUT) };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
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
