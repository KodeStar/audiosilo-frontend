import { CLOTH_COLORS, hashString } from '@/lib/monogram';

import { contrast, luminance, spinePalette } from './spine-colors';
import { fitSpineTitle, SPINE_MIN_FONT, spineDims, spineGeometry, textAdvance } from './spine-fit';

describe('textAdvance', () => {
  it('weights character classes', () => {
    expect(textAdvance('iii', 'display')).toBeLessThan(textAdvance('aaa', 'display'));
    expect(textAdvance('MMM', 'display')).toBeGreaterThan(textAdvance('AAA', 'display'));
    expect(textAdvance('吾輩', 'sans')).toBe(2);
    expect(textAdvance('', 'sans')).toBe(0);
  });
});

describe('fitSpineTitle', () => {
  const fit = (text: string, length: number, width = 30, base = 12.5) =>
    fitSpineTitle({ text, base, length, across: width - 6, width, font: 'display' });

  it('keeps the base size when the title fits', () => {
    const f = fit('Dune', 150);
    expect(f).toMatchObject({ lines: ['Dune'], fontSize: 12.5, ellipsize: false });
    expect(f.letterSpacing).toBeGreaterThan(0);
  });

  it('tightens tracking before shrinking', () => {
    // Fits at the base with tight tracking but not with the loose one.
    const em = textAdvance('Leviathan Wakes', 'display');
    const loose = (em + 15 * 0.02) * 12.5;
    const f = fit('Leviathan Wakes', loose - 1);
    expect(f.fontSize).toBe(12.5);
    expect(f.letterSpacing).toBeLessThan(0);
  });

  it('shrinks to no less than 82% on one line', () => {
    const em = textAdvance('Leviathan Wakes', 'display');
    const length = (em + 15 * -0.02) * 12.5 * 0.9;
    const f = fit('Leviathan Wakes', length);
    expect(f.lines).toHaveLength(1);
    expect(f.fontSize).toBeCloseTo(12.5 * 0.9, 5);
  });

  it('wraps to two lines on a spine 40+ wide when that sets it larger', () => {
    const f = fit('The Remarkably Long Account of a Lighthouse Keeper', 150, 60);
    expect(f.lines).toHaveLength(2);
    expect(f.lines.join(' ')).toBe('The Remarkably Long Account of a Lighthouse Keeper');
    expect(f.ellipsize).toBe(false);
  });

  it('never wraps a spine narrower than 40', () => {
    const f = fit('The Remarkably Long Account of a Lighthouse Keeper', 150, 30);
    expect(f.lines).toHaveLength(1);
    expect(f.fontSize).toBeGreaterThanOrEqual(SPINE_MIN_FONT);
  });

  it('ellipsizes only below the 5px floor', () => {
    const long = 'The Remarkably Long and Occasionally Tedious Account of a Lighthouse Keeper';
    const f = fit(long, 60, 26);
    expect(f).toMatchObject({ fontSize: SPINE_MIN_FONT, ellipsize: true });
    expect(fit(long, 400, 26).ellipsize).toBe(false);
  });

  it('caps the size so one line fits across the spine', () => {
    expect(fit('Dune', 300, 12, 20).fontSize).toBeLessThanOrEqual(6 / 1.1 + 1e-9);
  });
});

describe('spineDims', () => {
  it('follows the listening length, clamped 24-72', () => {
    expect(spineDims(60, 'a').width).toBe(24);
    expect(spineDims(45 * 3600, 'a').width).toBe(Math.round(10 + Math.sqrt(2700) * 1.1));
    expect(spineDims(500 * 3600, 'a').width).toBe(72);
    expect(spineDims(undefined, 'a').width).toBe(spineDims(36_000, 'a').width);
  });

  it('scales and varies the height per title, stably', () => {
    const a = spineDims(36_000, 'Oathbringer', 1.5);
    expect(a).toEqual(spineDims(36_000, 'Oathbringer', 1.5));
    expect(a.height).toBe(Math.round((172 + (hashString('Oathbringer') % 5) * 9) * 1.5));
  });
});

describe('spineGeometry', () => {
  it('gives the title what the rows leave', () => {
    const g = spineGeometry(40, 200, 1, 'none');
    expect(g.padTop + g.indexHeight + g.bandMargin * 2 + g.bandHeight + g.padBottom).toBe(200);
    expect(spineGeometry(40, 200, 1, 'finished').length).toBeLessThan(g.length);
  });
});

describe('spinePalette', () => {
  it('uses the cover colour and readable type', () => {
    const p = spinePalette({ bg: '#F08A25', accent: '#572e06' }, 'x');
    expect(p.body).toBe('#f08a25');
    expect(p.band).toBe('#572e06');
    expect(contrast(p.body, p.ink)).toBeGreaterThan(3);
  });

  it('falls back to a stable palette colour by title', () => {
    const p = spinePalette(undefined, 'Blood Rites');
    expect(CLOTH_COLORS).toContain(p.body);
    expect(spinePalette(undefined, 'Blood Rites')).toEqual(p);
    expect(p.ink).toBe('#ffffff');
  });

  it('bands with the type colour when the accent is too close to the body', () => {
    expect(spinePalette({ bg: '#8c98ae', accent: '#8c98af' }, 'x').band).toBe(
      spinePalette({ bg: '#8c98ae' }, 'x').ink,
    );
  });

  it('computes WCAG luminance', () => {
    expect(luminance('#ffffff')).toBeCloseTo(1);
    expect(luminance('#000000')).toBe(0);
  });
});
