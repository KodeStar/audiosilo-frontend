import { Platform } from 'react-native';

import { webOrigin } from '@/lib/base-url';

// base-url.ts branches on Platform.OS at call time, so we flip it per case.
function setPlatform(os: string) {
  (Platform as { OS: string }).OS = os;
}

describe('webOrigin', () => {
  const realWindow = globalThis.window;

  afterEach(() => {
    setPlatform('ios');
    globalThis.window = realWindow;
  });

  it('returns the origin with trailing slashes stripped on web', () => {
    setPlatform('web');
    globalThis.window = {
      location: { origin: 'https://example.test///' },
    } as unknown as Window & typeof globalThis;
    expect(webOrigin()).toBe('https://example.test');
  });

  it('leaves a clean origin untouched on web', () => {
    setPlatform('web');
    globalThis.window = {
      location: { origin: 'http://localhost:8081' },
    } as unknown as Window & typeof globalThis;
    expect(webOrigin()).toBe('http://localhost:8081');
  });

  it('returns null on native', () => {
    setPlatform('ios');
    expect(webOrigin()).toBeNull();
  });
});
