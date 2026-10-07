import { clampRate, wallClockSeconds } from './rate';

describe('wallClockSeconds', () => {
  it('scales content-seconds by the playback rate', () => {
    expect(wallClockSeconds(60, 2)).toBe(30);
    expect(wallClockSeconds(60, 1)).toBe(60);
    expect(wallClockSeconds(90, 1.5)).toBe(60);
  });

  it('defaults to 1x and guards a non-positive rate', () => {
    expect(wallClockSeconds(60)).toBe(60);
    expect(wallClockSeconds(60, 0)).toBe(60);
    expect(wallClockSeconds(60, -2)).toBe(60);
  });

  it('never returns a negative countdown', () => {
    expect(wallClockSeconds(-30, 2)).toBe(0);
  });
});

describe('clampRate', () => {
  it('keeps a speed inside 0.5x..2x', () => {
    expect(clampRate(1.25)).toBe(1.25);
    expect(clampRate(3)).toBe(2);
    expect(clampRate(0.1)).toBe(0.5);
  });
});
