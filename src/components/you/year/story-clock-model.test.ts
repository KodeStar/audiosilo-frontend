import { clockPetals, clockRadii, hourAngle } from './story-clock-model';

describe('story clock', () => {
  it('draws a petal per hour with listening, the busiest bright', () => {
    const hours = Array.from({ length: 24 }, () => 0);
    hours[7] = 80;
    hours[22] = 100;
    hours[13] = 10;
    const petals = clockPetals(hours, 200);
    expect(petals.map((p) => [p.hour, p.peak])).toEqual([
      [7, true],
      [13, false],
      [22, true],
    ]);
    expect(petals[0].d).toMatch(
      /^M[\d. ]+ L[\d. ]+ A[\d. ]+ 0 0 1 [\d. ]+ L[\d. ]+ A[\d. ]+ 0 0 0 [\d. ]+Z$/,
    );
  });

  it('draws nothing without listening', () => {
    expect(
      clockPetals(
        Array.from({ length: 24 }, () => 0),
        200,
      ),
    ).toEqual([]);
  });

  it('puts 00 at the top and 06 on the right', () => {
    expect(Math.sin(hourAngle(0))).toBeCloseTo(-1);
    expect(Math.cos(hourAngle(6))).toBeCloseTo(1);
    expect(clockRadii(100)).toEqual({ inner: 22, outer: 42 });
  });
});
