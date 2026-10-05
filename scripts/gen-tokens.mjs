// Generates the app's colour tokens from their one source, src/theme/tokens.json:
//   - the colour region inside src/global.css (between the generated-region markers;
//     everything outside them is hand-written and left alone): the fixed `palette` as
//     an `@theme` block, and the Stacks semantic `themes` as Uniwind theme variables
//     (`@variant light` / `@variant dark`), which Tailwind/Uniwind turn into
//     `bg-*`/`text-*`/`border-*` utilities that follow the theme, and
//   - src/theme/tokens.ts, the raw `colors` values for native props.
//
//   npm run gen:tokens                      # rewrite both outputs
//   node scripts/gen-tokens.mjs --check     # exit 1 if either is stale (no writes)
//
// `npm test` (and so CI) runs `--check` before jest, so drift between the JSON and the
// checked-in outputs fails the standard gate. The generated region and tokens.ts go
// through Prettier (the repo's own config) so they are already `format`-clean; the
// hand-written CSS around the region is kept byte for byte, so `--check` reports token
// drift only (formatting is `npm run format`'s job). The pure helpers are exported for
// scripts/gen-tokens.test.mjs.

import { realpathSync } from 'node:fs';
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
// rgb()/rgba() in comma or space syntax, alpha optional (`rgb(18 28 54 / 0.16)`).
const RGB =
  /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*(?:[,/]\s*(\d*\.?\d+)\s*)?\)$/i;

/** An object's keys minus `$`-prefixed annotations (`$comment`), at any level. */
const keysOf = (obj) => Object.keys(obj).filter((k) => !k.startsWith('$'));

/**
 * A colour in its canonical output form - `#rrggbb` lowercased, or `rgba(r, g, b, a)` /
 * `rgb(r, g, b)` (the comma syntax every React Native version parses) - or undefined
 * when `value` is neither a 6-digit hex nor a valid rgb()/rgba().
 */
export function normalizeColor(value) {
  if (typeof value !== 'string') return undefined;
  if (HEX.test(value)) return value.toLowerCase();
  const m = RGB.exec(value.trim());
  if (!m) return undefined;
  const [r, g, b] = m.slice(1, 4).map(Number);
  if ([r, g, b].some((c) => c > 255)) return undefined;
  if (m[4] === undefined) return `rgb(${r}, ${g}, ${b})`;
  const a = Number(m[4]);
  return a > 1 ? undefined : `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** `card-foreground` -> `cardForeground`, `chart-1` -> `chart1`. */
export const camelName = (name) => name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

/** Shade keys in display order: DEFAULT first, then numeric (50, 100, ..., 750, 800, 840, ...). */
const shadeKeys = (family) =>
  keysOf(family).sort((a, b) =>
    a === 'DEFAULT' ? -1 : b === 'DEFAULT' ? 1 : Number(a) - Number(b),
  );

/**
 * Flattens the palette to `{ 'gray-50': colour, 'white': colour, ... }`. A family's shade
 * may name another palette colour ("red-500") instead of a value, one level deep.
 */
export function flattenPalette(palette) {
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
  const colour = (key) => {
    const v = normalizeColor(raw[key]) ?? normalizeColor(raw[raw[key]]);
    if (!v) throw new Error(`tokens.json: palette "${key}" is not a colour or an alias of one`);
    return v;
  };
  return Object.fromEntries(Object.keys(raw).map((k) => [k, colour(k)]));
}

/** Validates the `themes` block: same keys in the same order, every value a colour. */
export function parseThemes(themes, paletteNames = []) {
  const { light, dark } = themes;
  if (!light || !dark) throw new Error('tokens.json: themes.light and themes.dark are required');
  if (keysOf(light).join() !== keysOf(dark).join()) {
    throw new Error('tokens.json: themes.light and themes.dark must have the same keys in order');
  }
  const out = {};
  for (const [scheme, values] of [
    ['light', light],
    ['dark', dark],
  ]) {
    out[scheme] = {};
    for (const name of keysOf(values)) {
      if (paletteNames.includes(name)) {
        throw new Error(`tokens.json: "${name}" is both a palette colour and a theme token`);
      }
      const v = normalizeColor(values[name]);
      if (!v) throw new Error(`tokens.json: themes.${scheme}.${name} is not a colour`);
      out[scheme][name] = v;
    }
  }
  return out;
}

/** The generated CSS region (unformatted). */
export function renderCss(flat, themes) {
  const vars = (values, indent) =>
    Object.entries(values).map(([k, v]) => `${indent}--color-${k}: ${v};`);
  return [
    CSS_START,
    '@theme {',
    // Drop Tailwind's default palette: every colour class must be a token from
    // tokens.json, so a stray `bg-gray-200` compiles to nothing instead of an unpinned
    // OKLCH gray that ignores the theme. This also clears the `unset` placeholders
    // Uniwind declares for the theme variables (imported above this region), so they
    // are declared again here: the utility reads the variable, the @variant blocks
    // below give it each theme's value.
    '  --color-*: initial;',
    ...vars(flat, '  '),
    ...Object.keys(themes.light).map((k) => `  --color-${k}: unset;`),
    '}',
    '@layer theme {',
    '  :root {',
    ...['light', 'dark'].flatMap((scheme) => [
      `    @variant ${scheme} {`,
      ...vars(themes[scheme], '      '),
      '    }',
    ]),
    '  }',
    '}',
    CSS_END,
  ].join('\n');
}

/** src/theme/tokens.ts (unformatted). */
export function renderTs(flat, themes) {
  const fixed = Object.entries(flat)
    // Only the palette's plain colours (white/black) are native-prop values; the
    // shaded families exist for classes only.
    .filter(([k]) => !/-\d+$/.test(k))
    .map(([k, v]) => `  ${camelName(k)}: '${v}',`);
  const scheme = (name) => [
    `  ${name}: {`,
    ...Object.entries(themes[name]).map(([k, v]) => `    ${camelName(k)}: '${v}', // --color-${k}`),
    '  },',
  ];
  return [
    `// GENERATED FILE - DO NOT EDIT. Source: src/theme/tokens.json; regenerate with ${REGEN}.`,
    '',
    '/**',
    ' * Raw colour values for native props that need a string rather than a className',
    ' * (status bar, ActivityIndicator, TextInput placeholders, react-native-svg fills, the',
    " * navigation theme): the fixed palette colours, and each theme's Stacks semantic tokens.",
    " * Read the current theme's with `useThemeColors()` (@/theme/use-theme-colors). The same",
    ' * values back the Tailwind classes (src/global.css).',
    ' */',
    'export const colors = {',
    ...fixed,
    ...scheme('light'),
    ...scheme('dark'),
    '} as const;',
    '',
    "/** One theme's semantic colours (`colors.light` / `colors.dark`). */",
    'export type ThemeColors = { readonly [K in keyof typeof colors.light]: string };',
    '',
  ].join('\n');
}

async function render() {
  const tokens = JSON.parse(await readFile(SOURCE, 'utf8'));
  const flat = flattenPalette(tokens.palette);
  const themes = parseThemes(tokens.themes, Object.keys(flat));
  const fmt = async (text, filepath) =>
    prettier.format(text, { ...(await prettier.resolveConfig(filepath)), filepath });

  const cssRegion = (await fmt(renderCss(flat, themes), CSS_OUT)).trimEnd();
  const currentCss = await readFile(CSS_OUT, 'utf8');
  const start = currentCss.indexOf(START_TAG);
  const end = currentCss.indexOf(CSS_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${relative(root, CSS_OUT)}: generated-region markers not found`);
  }
  const css = currentCss.slice(0, start) + cssRegion + currentCss.slice(end + CSS_END.length);

  const ts = await fmt(renderTs(flat, themes), TS_OUT);
  return { css, ts };
}

async function main() {
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

// Run only as a script, not when the test imports the helpers (realpath: import.meta.url
// is the resolved path, argv[1] is as typed).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
