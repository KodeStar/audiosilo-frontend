import { corsModeFor } from './cors-mode';

const PAGE = { origin: 'https://books.example', href: 'https://books.example/web/library' };

describe('corsModeFor', () => {
  it('loads another origin in CORS mode', () => {
    expect(corsModeFor('https://other.example/api/v1/libraries/1/cover?token=k', PAGE)).toBe(
      'anonymous',
    );
    // Another port or scheme is another origin.
    expect(corsModeFor('http://books.example/api/v1/stream?token=k', PAGE)).toBe('anonymous');
    expect(corsModeFor('https://books.example:8443/x.mp3', PAGE)).toBe('anonymous');
  });

  it('leaves the same origin, the offline copies, blob and data URLs as they were', () => {
    expect(corsModeFor('https://books.example/api/v1/libraries/1/cover?token=k', PAGE)).toBe(
      undefined,
    );
    expect(corsModeFor('/api/v1/libraries/1/cover?token=k', PAGE)).toBe(undefined);
    expect(corsModeFor('https://books.example/web/_offline/c1/1/A/01.mp3', PAGE)).toBe(undefined);
    expect(corsModeFor('blob:https://books.example/2b8f-11', PAGE)).toBe(undefined);
    expect(corsModeFor('data:image/png;base64,iVBORw0KGgo=', PAGE)).toBe(undefined);
  });

  it('asks nothing of a missing or unparseable URL, or with no page (native)', () => {
    expect(corsModeFor(undefined, PAGE)).toBe(undefined);
    expect(corsModeFor('', PAGE)).toBe(undefined);
    expect(corsModeFor('http://[bad', PAGE)).toBe(undefined);
    expect(corsModeFor('https://other.example/x.jpg', null)).toBe(undefined);
    // Jest runs the native platform: no page, so never CORS mode.
    expect(corsModeFor('https://other.example/x.jpg')).toBe(undefined);
  });
});
