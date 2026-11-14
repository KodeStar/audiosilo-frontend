import type { ApiClient } from '@/api/client';

import { communityCoverSource, noCommunityCover } from './community-cover';

let proxyHeaders: Record<string, string> | undefined;
const api = {
  communityCoverUrl: jest.fn(
    (lib: number, path: string, url: string, o?: { size?: number }) =>
      `proxy:${lib}:${path}:${url}:${o?.size}`,
  ),
  proxyHeadersFor: jest.fn(() => proxyHeaders),
} as unknown as ApiClient;
afterEach(() => {
  proxyHeaders = undefined;
});

const base = {
  coverUrl: 'https://m.media-amazon.com/x.jpg',
  size: 320 as const,
  api,
  libraryId: 3,
  path: 'A/Book',
};

describe('communityCoverSource', () => {
  it('loads from the server when it serves community covers, on every platform', () => {
    for (const web of [true, false]) {
      expect(communityCoverSource({ ...base, proxied: true, web })).toBe(
        'proxy:3:A/Book:https://m.media-amazon.com/x.jpg:320',
      );
    }
  });

  it("behind an auth proxy the app sends the connection's headers to the server's URL only", () => {
    proxyHeaders = { 'X-Proxy': 'secret' };
    const uri = 'proxy:3:A/Book:https://m.media-amazon.com/x.jpg:320';
    expect(communityCoverSource({ ...base, proxied: true, web: false })).toEqual({
      uri,
      headers: { 'X-Proxy': 'secret' },
    });
    expect(api.proxyHeadersFor).toHaveBeenLastCalledWith(uri);
    // The web's <img> sends no headers; the cover's own host never gets one.
    expect(communityCoverSource({ ...base, proxied: true, web: true })).toBe(uri);
    expect(communityCoverSource({ ...base, proxied: false, web: false })).toBe(base.coverUrl);
  });

  it('without meta_covers: native loads the cover_url directly, web shows the placeholder', () => {
    expect(communityCoverSource({ ...base, proxied: false, web: false })).toBe(base.coverUrl);
    // The web player's CSP would block (and log) the cover's own host.
    expect(communityCoverSource({ ...base, proxied: false, web: true })).toBeNull();
  });

  it('loads nothing while the capability is unknown, or with no cover or client', () => {
    expect(communityCoverSource({ ...base, proxied: undefined, web: false })).toBeNull();
    expect(communityCoverSource({ ...base, proxied: undefined, web: true })).toBeNull();
    expect(
      communityCoverSource({ ...base, coverUrl: undefined, proxied: true, web: true }),
    ).toBeNull();
    expect(communityCoverSource({ ...base, coverUrl: '', proxied: false, web: false })).toBeNull();
    expect(communityCoverSource({ ...base, api: null, proxied: true, web: true })).toBeNull();
  });

  it('noCommunityCover always shows the placeholder', () => {
    expect(noCommunityCover(base.coverUrl, 160)).toBeNull();
  });
});
