import { Uniwind } from 'uniwind';

import tokens from './tokens.json';
import {
  applyHighContrast,
  contrastVariables,
  cssVariableName,
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
    // The generated keys are the generator's camelName of each token, in tokens.json's order.
    expect(Object.keys(colors.light).map(cssVariableName)).toEqual(
      Object.keys(tokens.themes.light)
        .filter((k) => !k.startsWith('$'))
        .map((name) => `--color-${name}`),
    );
  });
});

describe('contrastVariables', () => {
  it.each(['light', 'dark'] as const)('lists only what high contrast changes in %s', (scheme) => {
    const on = contrastVariables(scheme, true);
    const off = contrastVariables(scheme, false);
    expect(on['--color-muted-foreground']).toBe(colors.highContrast[scheme].mutedForeground);
    expect(off['--color-muted-foreground']).toBe(colors[scheme].mutedForeground);
    // The same variables both ways, so turning it off puts every one back.
    expect(Object.keys(off)).toEqual(Object.keys(on));
    expect(Object.keys(on)).toHaveLength(Object.keys(tokens.highContrast[scheme]).length);
    expect(on).not.toHaveProperty('--color-background');
    expect(on).not.toHaveProperty('--color-chart-1');
  });
});

describe('applyHighContrast', () => {
  const update = jest.spyOn(Uniwind, 'updateCSSVariables');
  beforeEach(() => {
    applyHighContrast(false);
    update.mockClear();
  });

  it('writes both schemes, high contrast on and the normal colours back off', () => {
    applyHighContrast(true);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith('light', contrastVariables('light', true));
    expect(update).toHaveBeenCalledWith('dark', contrastVariables('dark', true));

    update.mockClear();
    applyHighContrast(false);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith('light', contrastVariables('light', false));
    expect(update).toHaveBeenCalledWith('dark', contrastVariables('dark', false));
  });

  it('writes nothing when the variables already hold what is asked', () => {
    applyHighContrast(false);
    expect(update).not.toHaveBeenCalled();
    applyHighContrast(true);
    update.mockClear();
    applyHighContrast(true);
    expect(update).not.toHaveBeenCalled();
  });
});
