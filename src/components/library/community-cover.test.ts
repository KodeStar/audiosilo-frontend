import type { ApiClient } from '@/api/client';

import { communityCoverSource, noCommunityCover } from './community-cover';

const api = {
  communityCoverUrl: jest.fn(
    (lib: number, path: string, url: string, o?: { size?: number }) =>
      `proxy:${lib}:${path}:${url}:${o?.size}`,
  ),
} as unknown as ApiClient;

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
