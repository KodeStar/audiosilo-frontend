import { coverTint, hexAlpha, washCss, washLayers } from './cover-tint';

const BRAND = '#db2777';

describe('coverTint', () => {
  it('takes the dominant and vibrant colours', () => {
    expect(coverTint({ bg: '#102030', accent: '#f0a020', on_accent: '#000000' }, BRAND)).toEqual({
      tint: '#102030',
      accent: '#f0a020',
    });
  });

  it('falls back to the brand pink without a vibrant colour', () => {
    expect(coverTint({ bg: '#102030' }, BRAND)).toEqual({ tint: '#102030', accent: BRAND });
    expect(coverTint({ bg: '#102030', accent: 'pink' }, BRAND)).toEqual({
      tint: '#102030',
      accent: BRAND,
    });
  });

  it('has no wash without cover colours', () => {
    expect(coverTint(undefined, BRAND)).toBeNull();
    expect(coverTint({ bg: 'rgb(1,2,3)' }, BRAND)).toBeNull();
  });
});

describe('the wash', () => {
  const tint = { tint: '#102030', accent: '#f0a020' };

  it('converts a hex colour to rgba', () => {
    expect(hexAlpha('#102030', 0.3)).toBe('rgba(16, 32, 48, 0.3)');
    expect(hexAlpha('#ffffff', 2)).toBe('rgba(255, 255, 255, 1)');
  });

  it('is stronger in dark mode (30% light, 42% dark)', () => {
    expect(washLayers(tint, 'light')[0].opacity).toBe(0.3);
    expect(washLayers(tint, 'dark')[0].opacity).toBe(0.42);
    expect(washLayers(tint, 'light')[1].opacity).toBeCloseTo(0.165);
  });

  it('lays the card wash from opposite corners and the hero wash from the top', () => {
    expect(washLayers(tint, 'light', 'card').map((l) => [l.cx, l.cy, l.color])).toEqual([
      [0, 0, '#102030'],
      [1, 1, '#f0a020'],
    ]);
    expect(washLayers(tint, 'light', 'hero').every((l) => l.cy <= 0.1)).toBe(true);
  });

  it('writes CSS radial gradients for the web', () => {
    expect(washCss(washLayers(tint, 'light'))).toBe(
      'radial-gradient(70% 120% at 0% 0%, rgba(16, 32, 48, 0.3), transparent 70%), ' +
        'radial-gradient(60% 100% at 100% 100%, rgba(240, 160, 32, 0.165), transparent 70%)',
    );
  });
});
