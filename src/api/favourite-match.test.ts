import { isFavouriteOf } from './favourite-match';

describe('isFavouriteOf', () => {
  it('matches a favourite by its library and its exact path', () => {
    const f = { library_id: 2, path: 'A/Book' };
    expect(isFavouriteOf(f, 2, 'A/Book')).toBe(true);
    expect(isFavouriteOf(f, 1, 'A/Book')).toBe(false);
    expect(isFavouriteOf(f, 2, 'A/Book/Part 1')).toBe(false);
    expect(isFavouriteOf(f, 2, 'A')).toBe(false);
  });
});
