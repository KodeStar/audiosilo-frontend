// The web's side of the EPUB file seam (ebook-file.ts; jest runs the native platform, so it
// is imported by its own name): no reader cache, only a download's saved copy, looked for
// through the web download engine (its Cache API check is engine.web.test.ts's).
const mockStored = new Set<string>();
jest.mock('@/downloads/engine', () => ({
  engine: { fileExists: async (uri: string) => mockStored.has(uri) },
}));

const { cachedEbookUri, clearEbookCache, hasLocalEbook } =
  jest.requireActual<typeof import('./ebook-file')>('./ebook-file.ts');

const ref = { connectionId: 'c1', libraryId: 2, path: 'A/Book', size: 1000 };
const SAVED = 'audiosilo-downloads/c1/2/b/book.epub';

describe('ebook-file (web)', () => {
  beforeEach(() => {
    mockStored.clear();
    mockStored.add(SAVED);
  });

  it('has the EPUB on this device only when the download saved it', async () => {
    await expect(hasLocalEbook({ ...ref, saved: SAVED })).resolves.toBe(true);
    await expect(hasLocalEbook(ref)).resolves.toBe(false);
    await expect(hasLocalEbook({ ...ref, saved: '' })).resolves.toBe(false);
  });

  it('has none when the browser evicted the saved copy', async () => {
    mockStored.clear();
    await expect(hasLocalEbook({ ...ref, saved: SAVED })).resolves.toBe(false);
  });

  it('has no cache to clear, and no reader copy for a download to take', async () => {
    await expect(clearEbookCache('c1')).resolves.toBeUndefined();
    await expect(cachedEbookUri(ref)).resolves.toBeNull();
  });
});
