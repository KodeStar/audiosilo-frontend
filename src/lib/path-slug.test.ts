import { pathSlug } from './path-slug';

describe('pathSlug', () => {
  it('is stable: saved downloads are found under it at every launch', () => {
    // The readable tail (40 characters at most) and the path's hash.
    expect(pathSlug('Brian J. Nordon/Quest Academy/QA06 - Loyalists')).toBe(
      'J._Nordon_Quest_Academy_QA06_-_Loyalists-62db0286',
    );
  });

  it('tells apart paths whose readable tails are the same', () => {
    expect(pathSlug('a/b')).toBe('a_b-b8855f7');
    expect(pathSlug('a_b')).toBe('a_b-b885c27');
  });

  it('names a path of nothing but separators "book"', () => {
    expect(pathSlug('///')).toBe('book-b878112');
  });
});
