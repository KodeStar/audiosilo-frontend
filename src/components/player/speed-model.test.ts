import { isSpeed, snapSpeed, SPEED_PRESETS, timeLeftAt } from './speed-model';

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

  it('measures time left in wall-clock time at the speed', () => {
    expect(timeLeftAt(7200, 3600, 2)).toBe(1800);
    expect(timeLeftAt(7200, 3600, 1)).toBe(3600);
    expect(timeLeftAt(7200, 8000, 1)).toBe(0);
  });
});
