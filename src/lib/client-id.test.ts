import { CLIENT_HEADER, clientIdentity, shouldIdentify } from '@/lib/client-id';

describe('clientIdentity', () => {
  it('formats AudioSilo/<version> (<platform>)', () => {
    expect(CLIENT_HEADER).toBe('X-AudioSilo-Client');
    expect(clientIdentity('1.4.2', 'ios')).toBe('AudioSilo/1.4.2 (ios)');
    expect(clientIdentity('2.0.0', 'web')).toBe('AudioSilo/2.0.0 (web)');
  });

  it('falls back to dev when the version is empty', () => {
    expect(clientIdentity('', 'android')).toBe('AudioSilo/dev (android)');
  });
});

describe('shouldIdentify', () => {
  it('always identifies on native, regardless of origin', () => {
    expect(shouldIdentify('https://h', 'ios', null)).toBe(true);
    expect(shouldIdentify('https://h', 'android', 'https://other')).toBe(true);
  });

  it('identifies on web when the API base is same-origin with the page', () => {
    expect(shouldIdentify('https://h.test', 'web', 'https://h.test')).toBe(true);
    expect(shouldIdentify('https://h.test:8443/sub', 'web', 'https://h.test:8443')).toBe(true);
  });

  it('does not identify on web when the API base is cross-origin', () => {
    expect(shouldIdentify('https://api.test', 'web', 'http://localhost:8081')).toBe(false);
    expect(shouldIdentify('http://h.test', 'web', 'https://h.test')).toBe(false);
  });

  it('does not identify on web when the base URL cannot be parsed', () => {
    expect(shouldIdentify('not a url', 'web', 'https://h.test')).toBe(false);
  });

  it('does not identify on web without a page origin', () => {
    expect(shouldIdentify('https://h.test', 'web', null)).toBe(false);
  });
});
