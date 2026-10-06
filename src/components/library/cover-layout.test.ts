import { cardGrid, gridMetrics, pageGutter, shelfMetrics } from './cover-layout';

describe('cover layout', () => {
  it('uses the page gutter of each form factor', () => {
    expect(pageGutter('phone')).toBe(16);
    expect(pageGutter('tablet')).toBe(16);
    expect(pageGutter('desktop')).toBe(32);
  });

  it('sizes shelf tiles 132 on a phone and 164 elsewhere', () => {
    expect(shelfMetrics('phone').tile).toBe(132);
    expect(shelfMetrics('tablet').tile).toBe(164);
    expect(shelfMetrics('desktop').tile).toBe(164);
  });

  it('always lays a phone grid in two columns', () => {
    expect(gridMetrics(358, 'phone')).toEqual({
      columns: 2,
      tile: 172,
      columnGap: 14,
      rowGap: 22,
    });
  });

  it('fits as many 158+ columns as the width allows, sharing the rest', () => {
    // 4 x 158 + 3 x 22 = 698 fits in 700; 5 columns need 878.
    const m = gridMetrics(700, 'tablet');
    expect(m.columns).toBe(4);
    expect(m.tile).toBe(158);
    expect(gridMetrics(1200, 'desktop').columns).toBe(6);
    expect(gridMetrics(1200, 'desktop').tile).toBeGreaterThanOrEqual(158);
    // Never fewer than two.
    expect(gridMetrics(200, 'tablet').columns).toBe(2);
  });

  it('fits cards of a minimum width, one or two on a phone', () => {
    expect(gridMetrics(1200, 'desktop', cardGrid(300, 1)).columns).toBe(3);
    expect(gridMetrics(370, 'phone', cardGrid(300, 1)).columns).toBe(1);
    expect(gridMetrics(370, 'phone', cardGrid(176, 2)).columns).toBe(2);
    expect(gridMetrics(200, 'tablet', cardGrid(300, 1)).columns).toBe(1);
  });
});
