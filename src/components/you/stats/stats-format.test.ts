import { durationParts } from './stats-format';

describe('stats formatting', () => {
  it('splits a duration into figures and units', () => {
    expect(durationParts(11 * 3600 + 6 * 60)).toEqual([
      { n: '11', unit: 'h' },
      { n: '6', unit: 'm' },
    ]);
    expect(durationParts(0)).toEqual([{ n: '0', unit: 'm' }]);
  });
});
