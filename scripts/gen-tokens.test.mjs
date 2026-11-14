// Unit tests for the colour-token generator's pure helpers (`npm test` runs them with
// node's own test runner, before jest). The end-to-end output is covered by
// `gen-tokens.mjs --check` against the checked-in files.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  camelName,
  normalizeColor,
  parseHighContrast,
  parsePalette,
  parseThemes,
  renderCss,
  renderTs,
} from './gen-tokens.mjs';

test('normalizeColor accepts hex and rgb()/rgba() in comma or space syntax', () => {
  assert.equal(normalizeColor('#DB2777'), '#db2777');
  assert.equal(normalizeColor('rgb(18 28 54 / 0.16)'), 'rgba(18, 28, 54, 0.16)');
  assert.equal(normalizeColor('rgb(18 28 54 / .5)'), 'rgba(18, 28, 54, 0.5)');
  assert.equal(normalizeColor('rgba(255, 255, 255, 0.07)'), 'rgba(255, 255, 255, 0.07)');
  assert.equal(normalizeColor('rgb(1, 2, 3)'), 'rgb(1, 2, 3)');
});

test('normalizeColor rejects anything else', () => {
  for (const bad of [
    '#fff',
    'db2777',
    'red',
    'rgb(256 0 0)',
    'rgb(0 0 0 / 1.5)',
    'rgb(0 0)',
    'hsl(0 0% 0%)',
    42,
    undefined,
  ]) {
    assert.equal(normalizeColor(bad), undefined, String(bad));
  }
});

test('camelName', () => {
  assert.equal(camelName('card-foreground'), 'cardForeground');
  assert.equal(camelName('chart-1'), 'chart1');
  assert.equal(camelName('background'), 'background');
});

test('parsePalette normalises plain colours and rejects anything else', () => {
  assert.deepEqual(parsePalette({ $comment: 'ignored', white: '#FFFFFF', black: '#000000' }), {
    white: '#ffffff',
    black: '#000000',
  });
  assert.throws(() => parsePalette({ x: 'nope' }), /palette "x"/);
  // No shade families or aliases: the palette is only the fixed plain colours.
  assert.throws(() => parsePalette({ red: { 500: '#ef4444' } }), /palette "red"/);
  assert.throws(() => parsePalette({ white: '#ffffff', paper: 'white' }), /palette "paper"/);
});

test('parseThemes needs matching keys, valid colours and no palette clash', () => {
  const ok = parseThemes({
    light: { bg: '#FFFFFF', glass: 'rgb(0 0 0 / 0.5)' },
    dark: { bg: '#000000', glass: 'rgb(255 255 255 / 0.07)' },
  });
  assert.deepEqual(ok.light, { bg: '#ffffff', glass: 'rgba(0, 0, 0, 0.5)' });
  assert.throws(
    () =>
      parseThemes({ light: { a: '#000000', b: '#000000' }, dark: { b: '#000000', a: '#000000' } }),
    /same keys/,
  );
  assert.throws(
    () => parseThemes({ light: { a: 'pink' }, dark: { a: '#000000' } }),
    /themes\.light\.a/,
  );
  assert.throws(
    () => parseThemes({ light: { white: '#ffffff' }, dark: { white: '#ffffff' } }, ['white']),
    /both a palette colour and a theme token/,
  );
  assert.throws(() => parseThemes({ light: {} }), /required/);
});

test('renderCss emits the palette as @theme and the themes as Uniwind variants', () => {
  const css = renderCss(
    { white: '#ffffff' },
    { light: { 'brand-ink': '#a3195a' }, dark: { 'brand-ink': '#f78bbb' } },
  );
  assert.match(
    css,
    /@theme \{\n {2}--color-\*: initial;\n {2}--color-white: #ffffff;\n {2}--color-brand-ink: unset;\n\}/,
  );
  assert.match(css, /@variant light \{\n {6}--color-brand-ink: #a3195a;\n {4}\}/);
  assert.match(css, /@variant dark \{\n {6}--color-brand-ink: #f78bbb;\n {4}\}/);
});

test("parseHighContrast lays each scheme's overrides over its theme", () => {
  const themes = {
    light: { fg: '#111111', border: '#eeeeee' },
    dark: { fg: '#eeeeee', border: '#222222' },
  };
  const hc = parseHighContrast(
    { $comment: 'ignored', light: { border: '#888888' }, dark: { fg: '#FFFFFF' } },
    themes,
  );
  assert.deepEqual(hc.light, { fg: '#111111', border: '#888888' });
  assert.deepEqual(hc.dark, { fg: '#ffffff', border: '#222222' });
  // The themes themselves are untouched.
  assert.equal(themes.light.border, '#eeeeee');
});

test('parseHighContrast rejects unknown tokens, bad colours and a missing scheme', () => {
  const themes = { light: { fg: '#111111' }, dark: { fg: '#eeeeee' } };
  assert.throws(
    () => parseHighContrast({ light: { nope: '#000000' }, dark: {} }, themes),
    /highContrast\.light\.nope is not a theme token/,
  );
  // An inherited name (`toString`) is no theme token either.
  assert.throws(
    () => parseHighContrast({ light: { toString: '#000000' }, dark: {} }, themes),
    /highContrast\.light\.toString is not a theme token/,
  );
  assert.throws(
    () => parseHighContrast({ light: {}, dark: { fg: 'white' } }, themes),
    /highContrast\.dark\.fg is not a colour/,
  );
  assert.throws(() => parseHighContrast({ light: {} }, themes), /highContrast\.dark is required/);
  assert.throws(() => parseHighContrast(undefined, themes), /highContrast is required/);
});

test('renderTs emits plain palette colours, camelCased theme colours and the high-contrast sets', () => {
  const themes = {
    light: { 'card-foreground': '#121c36' },
    dark: { 'card-foreground': '#e7ebf4' },
  };
  const ts = renderTs({ white: '#ffffff' }, themes, {
    light: { 'card-foreground': '#000000' },
    dark: { 'card-foreground': '#ffffff' },
  });
  assert.match(ts, /white: '#ffffff',/);
  assert.match(ts, /\n {2}light: \{\n {4}cardForeground: '#121c36', \/\/ --color-card-foreground/);
  assert.match(ts, /\n {2}dark: \{\n {4}cardForeground: '#e7ebf4',/);
  assert.match(
    ts,
    /highContrast: \{\n {4}light: \{\n {6}cardForeground: '#000000',[^\n]*\n {4}\},\n {4}dark: \{\n {6}cardForeground: '#ffffff',/,
  );
});
