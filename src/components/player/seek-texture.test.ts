import {
  BAR_GAP,
  barCountFor,
  barsPath,
  hashString,
  MAX_BARS,
  resamplePeaks,
  seededRandom,
  seekBars,
  seekTexture,
} from './seek-texture';

describe('barCountFor', () => {
  it('fits 56 bars on a phone and 96 on the desktop player', () => {
    expect(barCountFor(350)).toBe(56);
    expect(barCountFor(640)).toBe(MAX_BARS);
    expect(barCountFor(1200)).toBe(MAX_BARS);
  });

  it('keeps a floor, and is 0 before layout', () => {
    expect(barCountFor(60)).toBe(24);
    expect(barCountFor(0)).toBe(0);
    expect(barCountFor(NaN)).toBe(0);
  });
});

describe('seekTexture', () => {
  it('is deterministic per key and count', () => {
    expect(seekTexture('srv:1:a#0', 56)).toEqual(seekTexture('srv:1:a#0', 56));
    expect(seekTexture('srv:1:a#0', 56)).toHaveLength(56);
  });

  it('differs between chapters', () => {
    expect(seekTexture('srv:1:a#0', 56)).not.toEqual(seekTexture('srv:1:a#1800', 56));
  });

  it('stays in range, with pauses between phrases', () => {
    const bars = seekTexture('a long chapter', 2000);
    expect(Math.min(...bars)).toBeGreaterThanOrEqual(0.12);
    expect(Math.max(...bars)).toBeLessThanOrEqual(1);
    const pauses = bars.filter((v) => v === 0.12).length / bars.length;
    expect(pauses).toBeGreaterThan(0.03);
    expect(pauses).toBeLessThan(0.12);
  });

  it('is empty for no bars', () => {
    expect(seekTexture('x', 0)).toEqual([]);
  });
});

describe('hashString / seededRandom', () => {
  it('are stable', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(a()).toBeGreaterThanOrEqual(0);
    expect(a()).toBeLessThan(1);
  });
});

describe('resamplePeaks', () => {
  it('takes the loudest peak per bar, scaled to the loudest', () => {
    expect(resamplePeaks([1, 2, 4, 2, 0, 0, 8, 4], 4)).toEqual([0.25, 0.5, 0.08, 1]);
  });

  it('stretches fewer peaks than bars', () => {
    expect(resamplePeaks([1, 2], 4)).toEqual([0.5, 0.5, 1, 1]);
  });

  it('is null when there is nothing usable', () => {
    expect(resamplePeaks([], 4)).toBeNull();
    expect(resamplePeaks([0, 0], 4)).toBeNull();
    expect(resamplePeaks([NaN], 4)).toBeNull();
    expect(resamplePeaks([1], 0)).toBeNull();
  });
});

describe('seekBars', () => {
  it('uses real peaks when given, else the texture', () => {
    expect(seekBars('k', 2, [1, 2])).toEqual([0.5, 1]);
    expect(seekBars('k', 2, [])).toEqual(seekTexture('k', 2));
    expect(seekBars('k', 2)).toEqual(seekTexture('k', 2));
  });
});

describe('barsPath', () => {
  it('draws one rounded bar per height across the width', () => {
    const d = barsPath([1, 0.5], 10, 20);
    // Two bars of (10 - 2) / 2 = 4 wide, the second starting at 4 + gap.
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d.startsWith('M1.5 0h1')).toBe(true);
    expect(d).toContain(`M${4 + BAR_GAP + 1.5} 5h1`);
  });

  it('is empty without bars or room', () => {
    expect(barsPath([], 10, 20)).toBe('');
    expect(barsPath([1], 0, 20)).toBe('');
  });
});
