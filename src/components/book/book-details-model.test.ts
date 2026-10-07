import { fileRows, FILES_SHOWN, playbackMode, visibleFiles } from './book-details-model';

describe('fileRows', () => {
  const book = {
    rel_path: 'A/Book',
    size: 3_600_000,
    duration: 3600,
    codec: 'mp3',
  };

  it("lists the chapters response's files with the book's codec", () => {
    const rows = fileRows(book, {
      codec: 'aac',
      files: [
        {
          rel_path: 'A/Book/Disc 1/01.m4a',
          seq: 0,
          duration: 1800,
          format: 'm4a',
          size: 1_800_000,
        },
        { rel_path: 'A/Book/Disc 2/01.m4a', seq: 1, duration: 0, format: 'm4a', size: 0 },
      ],
    });
    expect(rows).toEqual([
      { key: 'A/Book/Disc 1/01.m4a', name: 'Disc 1/01.m4a', codec: 'AAC', kbps: 8, duration: 1800 },
      { key: 'A/Book/Disc 2/01.m4a', name: 'Disc 2/01.m4a', codec: 'AAC', kbps: null, duration: 0 },
    ]);
  });

  it('is one row for a single-file book whose files are not listed', () => {
    const rows = fileRows({ ...book, rel_path: 'A/Book.mp3' });
    expect(rows).toEqual([
      { key: 'A/Book.mp3', name: 'Book.mp3', codec: 'MP3', kbps: 8, duration: 3600 },
    ]);
  });

  it("falls back to the item's own files", () => {
    const rows = fileRows({
      ...book,
      files: [{ rel_path: 'A/Book/1.mp3', seq: 0, duration: 60, format: 'mp3', size: 960_000 }],
    });
    expect(rows.map((r) => [r.name, r.kbps])).toEqual([['1.mp3', 128]]);
  });
});

describe('visibleFiles', () => {
  const rows = Array.from({ length: 10 }, (_, i) => i);

  it(`shows ${FILES_SHOWN} and folds the rest into "and N more files"`, () => {
    expect(visibleFiles(rows, false)).toEqual({ shown: [0, 1, 2, 3, 4, 5], hidden: 4 });
    expect(visibleFiles(rows, true)).toEqual({ shown: rows, hidden: 0 });
    expect(visibleFiles(rows.slice(0, 6), false)).toEqual({ shown: rows.slice(0, 6), hidden: 0 });
  });
});

describe('playbackMode', () => {
  it('plays a download from the device, else converted or direct', () => {
    expect(playbackMode({ downloaded: true, transcoded: true })).toBe('local');
    expect(playbackMode({ downloaded: false, transcoded: true })).toBe('converted');
    expect(playbackMode({ downloaded: false, transcoded: false })).toBe('direct');
  });
});
