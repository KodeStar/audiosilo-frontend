import { isActiveNav, matchesPath } from './nav';

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
