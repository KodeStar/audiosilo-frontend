// Unit tests for the colour-token generator's pure helpers (`npm test` runs them with
// node's own test runner, before jest). The end-to-end output is covered by
// `gen-tokens.mjs --check` against the checked-in files.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  camelName,
  normalizeColor,
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

test('renderTs emits plain palette colours and camelCased theme colours', () => {
  const ts = renderTs(
    { white: '#ffffff' },
    { light: { 'card-foreground': '#121c36' }, dark: { 'card-foreground': '#e7ebf4' } },
  );
  assert.match(ts, /white: '#ffffff',/);
  assert.match(ts, /light: \{\n {4}cardForeground: '#121c36', \/\/ --color-card-foreground/);
  assert.match(ts, /dark: \{\n {4}cardForeground: '#e7ebf4',/);
});
