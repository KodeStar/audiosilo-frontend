import { parseYearParams } from './year-params';

describe('parseYearParams', () => {
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
