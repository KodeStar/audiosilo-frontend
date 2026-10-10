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
  it("reads a key's connection, never past its first colon", () => {
    expect(connectionOfKey(contentKey('srv.3', 1, 'A/B:c'))).toBe('srv.3');
    expect(connectionOfKey('no-colon')).toBeNull();
    expect(connectionOfKey(':1:x')).toBeNull();
  });

  it("tells a connection's keys from a connection sharing its prefix", () => {
    expect(isKeyOf(contentKey('srv', 1, 'x'), 'srv')).toBe(true);
    expect(isKeyOf(contentKey('srvX', 1, 'x'), 'srv')).toBe(false);
    expect(isKeyOf(contentKey('srv.3', 1, 'x'), 'srv')).toBe(false);
  });
});
