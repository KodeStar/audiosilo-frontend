import { canRead } from './can-read';

const ebook = { path: 'A/Book/Book.epub', size: 1000 };

describe('canRead', () => {
  it('offers Read for a book with an ebook on a server with the reader', () => {
    expect(canRead(true, { ebook })).toBe(true);
  });

  it('hides Read without the capability (an older server, or not known yet)', () => {
    expect(canRead(false, { ebook })).toBe(false);
    expect(canRead(undefined, { ebook })).toBe(false);
  });

  it('hides Read for a book without an ebook, or not loaded yet', () => {
    expect(canRead(true, {})).toBe(false);
    expect(canRead(true, undefined)).toBe(false);
    expect(canRead(undefined, {}, true)).toBe(false);
  });

  it('offers Read for a downloaded EPUB while the capability is unknown (offline)', () => {
    expect(canRead(undefined, { ebook }, true)).toBe(true);
    expect(canRead(true, { ebook }, true)).toBe(true);
  });

  it('never against a server that says it has no reader, downloaded or not', () => {
    expect(canRead(false, { ebook }, true)).toBe(false);
  });
});
