import { Platform } from 'react-native';

import { bookOfAddress, signedOutHref } from './return-to';

const at = (url: string) => {
  const u = new URL(url, 'https://h');
  return { pathname: u.pathname, search: u.search };
};

describe('bookOfAddress', () => {
  it('reads the book page an address names, under the web base', () => {
    expect(bookOfAddress(at('/web/book/1?path=Jane%20Austen%2FEmma&connection=c'), '/web')).toEqual(
      { libraryId: 1, path: 'Jane Austen/Emma' },
    );
  });

  it('keeps a literal %xx in the path (decoded once)', () => {
    expect(bookOfAddress(at('/book/2?path=A%2FLit%2520Book'), '')).toEqual({
      libraryId: 2,
      path: 'A/Lit%20Book',
    });
  });

  it('is no book for any other page, a bad library id or no path', () => {
    expect(bookOfAddress(at('/web/library/1?path=A'), '/web')).toBeNull();
    expect(bookOfAddress(at('/web/book/abc?path=A'), '/web')).toBeNull();
    expect(bookOfAddress(at('/web/book/1'), '/web')).toBeNull();
    expect(bookOfAddress(at('/web/'), '/web')).toBeNull();
  });
});

describe('signedOutHref', () => {
  const os = Platform.OS;
  const g = globalThis as unknown as { window?: unknown };
  const saved = g.window;
  afterEach(() => {
    Platform.OS = os;
    g.window = saved;
  });

  it('is the connect flow carrying the book a web address names', () => {
    Platform.OS = 'web';
    g.window = { location: { pathname: '/book/3', search: '?path=A%2FB&connection=c' } };
    expect(signedOutHref()).toEqual({ pathname: '/connect', params: { book: '3', path: 'A/B' } });
  });

  it('is the bare connect flow for any other page, and on native', () => {
    Platform.OS = 'web';
    g.window = { location: { pathname: '/library', search: '' } };
    expect(signedOutHref()).toBe('/connect');
    Platform.OS = 'ios';
    g.window = { location: { pathname: '/book/3', search: '?path=A' } };
    expect(signedOutHref()).toBe('/connect');
  });
});
