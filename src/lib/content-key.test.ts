import { contentKey } from './content-key';

describe('contentKey', () => {
  it('composes (connectionId, libraryId, path)', () => {
    expect(contentKey('c1', 2, 'A/Book')).toBe('c1:2:A/Book');
  });

  it('scopes the same (libraryId, path) separately per connection', () => {
    expect(contentKey('c1', 2, 'A/Book')).not.toBe(contentKey('c2', 2, 'A/Book'));
  });
});
