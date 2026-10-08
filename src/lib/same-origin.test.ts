import { sameOrigin } from '@/lib/same-origin';

describe('sameOrigin', () => {
  const page = { href: 'https://s/web/player', origin: 'https://s' };

  it('is true for the page origin and urls relative to the page', () => {
    expect(sameOrigin('https://s/api/v1/libraries/2/stream?path=a', page)).toBe(true);
    expect(sameOrigin('/web/_offline/c1/2/a/0.mp3', page)).toBe(true);
    expect(sameOrigin('https://h.test:8443/sub', { origin: 'https://h.test:8443' })).toBe(true);
  });

  it('is false for another origin (host, scheme or port)', () => {
    expect(sameOrigin('https://other/api/v1/stream', page)).toBe(false);
    expect(sameOrigin('http://s/a', page)).toBe(false);
    expect(sameOrigin('https://s:8443/a', page)).toBe(false);
  });

  it('is false with no page, or a url that cannot be parsed', () => {
    expect(sameOrigin('https://s/a', undefined)).toBe(false);
    expect(sameOrigin('https://s/a', null)).toBe(false);
    // No href to resolve against: a relative url is not taken as same-origin.
    expect(sameOrigin('not a url', { origin: 'https://s' })).toBe(false);
  });
});
