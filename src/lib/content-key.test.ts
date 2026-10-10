import { connectionOfKey, contentKey, isKeyOf } from './content-key';

describe('contentKey', () => {
  it('composes (connectionId, libraryId, path)', () => {
    expect(contentKey('c1', 2, 'A/Book')).toBe('c1:2:A/Book');
  });

  it('scopes the same (libraryId, path) separately per connection', () => {
    expect(contentKey('c1', 2, 'A/Book')).not.toBe(contentKey('c2', 2, 'A/Book'));
  });
});

describe('connectionOfKey / isKeyOf', () => {
  it('reads the connection back from a key whose path has more colons', () => {
    const key = contentKey('srv.u1', 2, 'A/Book: Part 1');
    expect(connectionOfKey(key)).toBe('srv.u1');
    expect(connectionOfKey('no-colon')).toBeNull();
  });

  it('matches only the whole connection id', () => {
    const key = contentKey('srv.u1', 2, 'A/Book');
    expect(isKeyOf(key, 'srv.u1')).toBe(true);
    expect(isKeyOf(key, 'srv.u')).toBe(false);
    expect(isKeyOf(key, 'srv')).toBe(false);
  });
});
