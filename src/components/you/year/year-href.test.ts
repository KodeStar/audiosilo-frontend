import { parseYearParams, yearHref } from './year-href';

describe('yearHref', () => {
  it('leaves out what is the default', () => {
    expect(yearHref()).toEqual({ pathname: '/year', params: {} });
    expect(yearHref({ year: 2025, connection: 'c2', card: 3 })).toEqual({
      pathname: '/year',
      params: { year: '2025', connection: 'c2', card: '3' },
    });
    expect(yearHref({ card: 0 })).toEqual({ pathname: '/year', params: {} });
  });

  it('reads its params back, refusing what the server would', () => {
    expect(parseYearParams({ year: '2025', connection: 'c2', card: '3' })).toEqual({
      range: '2025',
      connection: 'c2',
      card: 3,
    });
    expect(parseYearParams({})).toEqual({ range: 'year', connection: undefined, card: 0 });
    expect(parseYearParams({ year: '1999', card: '-2' }).range).toBe('year');
    expect(parseYearParams({ year: '20255', card: 'x' })).toMatchObject({ range: 'year', card: 0 });
    expect(parseYearParams({ year: ['2024', '2023'] }).range).toBe('2024');
  });
});
