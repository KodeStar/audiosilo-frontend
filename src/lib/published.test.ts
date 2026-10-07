import { yearOf } from './published';

describe('yearOf', () => {
  it('takes the year of a published date, however precise', () => {
    expect(yearOf('2010')).toBe('2010');
    expect(yearOf('2010-08')).toBe('2010');
    expect(yearOf('2010-08-31')).toBe('2010');
  });

  it('is undefined without one', () => {
    expect(yearOf('')).toBeUndefined();
    expect(yearOf(undefined)).toBeUndefined();
    expect(yearOf('August 2010')).toBeUndefined();
  });
});
