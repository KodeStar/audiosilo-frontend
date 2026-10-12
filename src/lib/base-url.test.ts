import { Platform } from 'react-native';

import { IS_DEV, servedOrigin, webOrigin } from '@/lib/base-url';

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

describe('servedOrigin', () => {
  const realWindow = globalThis.window;

  afterEach(() => {
    setPlatform('ios');
    globalThis.window = realWindow;
  });

  it('is null under the Metro dev server, which is not the server', () => {
    // Jest runs with NODE_ENV=test, which reads as development.
    expect(IS_DEV).toBe(true);
    setPlatform('web');
    globalThis.window = {
      location: { origin: 'http://localhost:8081' },
    } as unknown as Window & typeof globalThis;
    expect(servedOrigin()).toBeNull();
  });

  it('is the origin in a production web build, and null on native', () => {
    jest.isolateModules(() => {
      const env = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const prod = require('@/lib/base-url') as typeof import('@/lib/base-url');
        setPlatform('web');
        globalThis.window = {
          location: { origin: 'https://books.example.com/' },
        } as unknown as Window & typeof globalThis;
        expect(prod.servedOrigin()).toBe('https://books.example.com');
        setPlatform('ios');
        expect(prod.servedOrigin()).toBeNull();
      } finally {
        process.env.NODE_ENV = env;
      }
    });
  });
});
