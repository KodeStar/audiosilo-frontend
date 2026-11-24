import { isWebAddress, redactUrls } from './feed-redact';

describe('redactUrls', () => {
  // Each answer is what the server's `redactPodcastText` gives for the same text.
  it.each([
    ['http://127.0.0.1:19487/feeds/urltitle.xml', 'http://127.0.0.1:19487/...'],
    [
      'Listen at http://127.0.0.1:19487/feeds/gone-url-title.xml today',
      'Listen at http://127.0.0.1:19487/... today',
    ],
    ['https://Example.COM.:443/a%2Fb?x=1&z=2#fragment', 'https://Example.COM.:443/...'],
    ['https://user:pa%40ss@Example.com/feed', 'https://Example.com/...'],
    ['HTTPS://Host.example/', 'https://Host.example'],
    ['http://host', 'http://host'],
    ['http://host?', 'http://host/...'],
    ['http://host#frag/secret', 'http://host'],
    ['http:///secret', '[redacted URL]'],
    ['http://user@/secret', '[redacted URL]'],
    ['http://ho{st/x', '[redacted URL]'],
    ['http://host:abc/x', '[redacted URL]'],
    ['http://[::1]:80/x', 'http://[::1]:80/...'],
    ['http://[::1/x', '[redacted URL]'],
    ['http://us"er@host/x', '[redacted URL]'],
    ['http://h%41st/x', '[redacted URL]'],
    ['http://h%C3%A9st/x', 'http://hést/...'],
    ['http://h%zzst/x', '[redacted URL]'],
    ['http://host/%zz', '[redacted URL]'],
    [
      'see "https://feeds.example.com/p/abc?token=s3cr3t" and https://b.example',
      'see "https://feeds.example.com/... and https://b.example',
    ],
    ['http://a@b@host/x', 'http://host/...'],
    ['https://example.com/feed.xml).', 'https://example.com/...'],
    ['http://host.', 'http://host.'],
    ['Morning Brief', 'Morning Brief'],
  ])('%s', (text, want) => {
    expect(redactUrls(text)).toBe(want);
  });
});

describe('isWebAddress', () => {
  it('is true only for a text that is one address', () => {
    expect(isWebAddress(' https://example.com/feed?key=1 ')).toBe(true);
    expect(isWebAddress('Listen at https://example.com/feed')).toBe(false);
    expect(isWebAddress('feed://example.com/feed')).toBe(false);
    expect(isWebAddress('Morning Brief')).toBe(false);
  });
});
