import { isBrowsePath } from './use-shell-effects';

describe('isBrowsePath', () => {
  it('keeps the library, its folders and the pages a browse pushes', () => {
    for (const p of [
      '/library',
      '/library/1',
      '/library/favourites',
      '/book/1',
      '/series',
      '/author',
      '/narrator',
      '/collection',
    ]) {
      expect(isBrowsePath(p)).toBe(true);
    }
  });

  it('leaves the other tabs', () => {
    for (const p of ['/', '/search', '/downloads', '/settings', '/account', '/libraryx']) {
      expect(isBrowsePath(p)).toBe(false);
    }
  });
});
