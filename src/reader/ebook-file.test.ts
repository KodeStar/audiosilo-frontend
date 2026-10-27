// The web's side of the EPUB file seam (ebook-file.ts; jest runs the native platform, so it
// is imported by its own name): no reader cache, only a download's saved copy.
const { cachedEbookUri, clearEbookCache, hasLocalEbook } =
  jest.requireActual<typeof import('./ebook-file')>('./ebook-file.ts');

const ref = { connectionId: 'c1', libraryId: 2, path: 'A/Book', size: 1000 };
const SAVED = 'audiosilo-downloads/c1/2/b/book.epub';

describe('ebook-file (web)', () => {
  const g = globalThis as { caches?: unknown };
  let stored: Set<string>;
  beforeEach(() => {
    stored = new Set([SAVED]);
    g.caches = { match: async (uri: string) => (stored.has(uri) ? {} : undefined) };
  });
  afterEach(() => {
    delete g.caches;
  });

  it('has the EPUB on this device only when the download saved it', async () => {
    await expect(hasLocalEbook({ ...ref, saved: SAVED })).resolves.toBe(true);
    await expect(hasLocalEbook(ref)).resolves.toBe(false);
    await expect(hasLocalEbook({ ...ref, saved: '' })).resolves.toBe(false);
  });

  it('has none when the browser evicted the saved copy, or the cache cannot be read', async () => {
    stored.clear();
    await expect(hasLocalEbook({ ...ref, saved: SAVED })).resolves.toBe(false);
    g.caches = {
      match: async () => {
        throw new Error('SecurityError');
      },
    };
    await expect(hasLocalEbook({ ...ref, saved: SAVED })).resolves.toBe(false);
    delete g.caches;
    await expect(hasLocalEbook({ ...ref, saved: SAVED })).resolves.toBe(false);
  });

  it('has no cache to clear, and no reader copy for a download to take', async () => {
    await expect(clearEbookCache('c1')).resolves.toBeUndefined();
    await expect(cachedEbookUri(ref)).resolves.toBeNull();
  });
});
