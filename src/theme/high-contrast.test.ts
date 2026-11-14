import { Uniwind } from 'uniwind';

import tokens from './tokens.json';
import {
  applyHighContrast,
  cssVariableName,
  cssVariables,
  highContrastActive,
  restoredHighContrast,
  themeColors,
} from './high-contrast';
import { colors } from './tokens';

describe('highContrastActive (the OS x the switch)', () => {
  it.each([
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ])('OS asks %s, switch on %s -> %s', (os, sw, on) => {
    expect(highContrastActive(os, sw)).toBe(on);
  });
});

describe('restoredHighContrast', () => {
  it('is on only for a stored true', () => {
    expect(restoredHighContrast(true)).toBe(true);
    for (const v of [false, null, undefined, 'true', 1, {}]) {
      expect(restoredHighContrast(v)).toBe(false);
    }
  });
});

describe('themeColors', () => {
  it('picks the generated set for the scheme and the flag', () => {
    expect(themeColors('light', false)).toBe(colors.light);
    expect(themeColors('dark', false)).toBe(colors.dark);
    expect(themeColors('light', true)).toBe(colors.highContrast.light);
    expect(themeColors('dark', true)).toBe(colors.highContrast.dark);
  });
});

describe('cssVariableName', () => {
  it('names the theme variable of every token in tokens.json', () => {
    // The reverse of the generator's camelName, for every token there is.
    const camel = (n: string) => n.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    for (const name of Object.keys(tokens.themes.light).filter((k) => !k.startsWith('$'))) {
      expect(cssVariableName(camel(name))).toBe(`--color-${name}`);
    }
  });

  it('lists every token of a set as a variable', () => {
    const vars = cssVariables(colors.highContrast.dark);
    expect(Object.keys(vars)).toHaveLength(Object.keys(colors.dark).length);
    expect(vars['--color-muted-foreground']).toBe(colors.highContrast.dark.mutedForeground);
    expect(vars['--color-chart-1']).toBe(colors.dark.chart1);
  });
});

describe('applyHighContrast', () => {
  const update = jest.spyOn(Uniwind, 'updateCSSVariables');
  afterEach(() => update.mockClear());

  it('writes both schemes, high contrast on and the normal colours back off', () => {
    applyHighContrast(true);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith('light', cssVariables(colors.highContrast.light));
    expect(update).toHaveBeenCalledWith('dark', cssVariables(colors.highContrast.dark));

    update.mockClear();
    applyHighContrast(false);
    expect(update).toHaveBeenCalledWith('light', cssVariables(colors.light));
    expect(update).toHaveBeenCalledWith('dark', cssVariables(colors.dark));
  });
});
