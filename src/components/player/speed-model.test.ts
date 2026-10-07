import { isSpeed, snapSpeed, SPEED_PRESETS, steppedRate } from './speed-model';

describe('speed model', () => {
  it('snaps to the 0.05 grid without float dust', () => {
    expect(snapSpeed(1.15 + 1e-12)).toBe(1.15);
    expect(snapSpeed(1.27)).toBe(1.25);
    expect(snapSpeed(1.28)).toBe(1.3);
    expect(snapSpeed(1 + 0.05 * 3)).toBe(1.15);
  });

  it('clamps to 0.5-2', () => {
    expect(snapSpeed(0.2)).toBe(0.5);
    expect(snapSpeed(3)).toBe(2);
    expect(snapSpeed(Number.NaN)).toBe(1);
  });

  it('has presets on the grid, ascending', () => {
    expect(SPEED_PRESETS.map(snapSpeed)).toEqual(SPEED_PRESETS);
    expect([...SPEED_PRESETS].sort((a, b) => a - b)).toEqual(SPEED_PRESETS);
  });

  it('matches a preset despite float error', () => {
    expect(isSpeed(1.1500000000000001, 1.15)).toBe(true);
    expect(isSpeed(1.2, 1.25)).toBe(false);
  });

  it('steps one notch on the grid, within the range', () => {
    expect(steppedRate(1, 1)).toBe(1.05);
    expect(steppedRate(1.25, -1)).toBe(1.2);
    expect(steppedRate(1.1, 1)).toBe(1.15); // not 1.1500000000000001
    expect(steppedRate(2, 1)).toBe(2);
    expect(steppedRate(0.5, -1)).toBe(0.5);
    // An off-grid stored speed lands back on the grid.
    expect(steppedRate(1.27, 1)).toBe(1.3);
  });
});
