import { canRead } from './can-read';

const ebook = { path: 'A/Book/Book.epub', size: 1000 };

describe('canRead', () => {
  it('offers Read on the web for a book with an ebook on a server with the reader', () => {
    expect(canRead(true, { ebook }, 'web')).toBe(true);
  });

  it('hides Read without the capability (an older server, or not known yet)', () => {
    expect(canRead(false, { ebook }, 'web')).toBe(false);
    expect(canRead(undefined, { ebook }, 'web')).toBe(false);
  });

  it('hides Read for a book without an ebook, or not loaded yet', () => {
    expect(canRead(true, {}, 'web')).toBe(false);
    expect(canRead(true, undefined, 'web')).toBe(false);
  });

  it('hides Read in the app until its reader host lands (Phase 3b-2)', () => {
    expect(canRead(true, { ebook }, 'ios')).toBe(false);
    expect(canRead(true, { ebook }, 'android')).toBe(false);
  });
});
