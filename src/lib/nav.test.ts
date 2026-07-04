import { contentPath, isActiveNav, matchesPath, scopeConnectionId } from './nav';

describe('matchesPath', () => {
  it('matches root only on an exact "/"', () => {
    expect(matchesPath('/', '/')).toBe(true);
    expect(matchesPath('/library', '/')).toBe(false);
  });

  it('matches a tab path and its descendant segments', () => {
    expect(matchesPath('/library', '/library')).toBe(true);
    expect(matchesPath('/library/5', '/library')).toBe(true);
    expect(matchesPath('/library/5/Author/Book', '/library')).toBe(true);
  });

  it('does not match a sibling that merely shares a string prefix', () => {
    expect(matchesPath('/librarything', '/library')).toBe(false);
  });
});

describe('isActiveNav', () => {
  const library = { match: '/library', alsoMatch: ['/book'] };

  it('is active across its own subtree', () => {
    expect(isActiveNav('/library/5', library)).toBe(true);
  });

  it('is active on an alsoMatch route (a book is reached through Library)', () => {
    expect(isActiveNav('/book/1/Author/Book', library)).toBe(true);
  });

  it('is inactive on an unrelated route', () => {
    expect(isActiveNav('/settings', library)).toBe(false);
  });

  it('handles items with no alsoMatch', () => {
    expect(isActiveNav('/settings', { match: '/settings' })).toBe(true);
    expect(isActiveNav('/', { match: '/settings' })).toBe(false);
  });
});

describe('contentPath', () => {
  it('strips a leading connection scope', () => {
    expect(contentPath('/s/abc/library/5')).toBe('/library/5');
    expect(contentPath('/s/abc/book/1/Author/Book')).toBe('/book/1/Author/Book');
  });

  it('maps a bare scope to root', () => {
    expect(contentPath('/s/abc')).toBe('/');
  });

  it('passes unscoped paths through unchanged', () => {
    expect(contentPath('/')).toBe('/');
    expect(contentPath('/library')).toBe('/library');
    expect(contentPath('/settings')).toBe('/settings');
  });
});

describe('scopeConnectionId', () => {
  it('extracts the connection id from a scoped path', () => {
    expect(scopeConnectionId('/s/abc/library/5')).toBe('abc');
    expect(scopeConnectionId('/s/abc/book/1/Author/Book')).toBe('abc');
    expect(scopeConnectionId('/s/abc')).toBe('abc');
  });

  it('returns empty for unscoped (aggregated) paths', () => {
    expect(scopeConnectionId('/')).toBe('');
    expect(scopeConnectionId('/library')).toBe('');
    expect(scopeConnectionId('/settings')).toBe('');
  });
});

describe('isActiveNav on scoped content paths', () => {
  const library = { match: '/library', alsoMatch: ['/book'] };

  it('keeps Library active inside a scoped library route', () => {
    expect(isActiveNav(contentPath('/s/abc/library/5'), library)).toBe(true);
  });

  it('keeps Library active on a scoped book route (via alsoMatch)', () => {
    expect(isActiveNav(contentPath('/s/abc/book/1/Author/Book'), library)).toBe(true);
  });
});
