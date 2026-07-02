import { wallClockSeconds } from './rate';

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
