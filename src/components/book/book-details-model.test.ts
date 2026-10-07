import type { MatchedBookMeta } from '@/components/library/book-meta';
import i18n from '@/i18n';

import {
  aboutContent,
  fileRows,
  FILES_SHOWN,
  playbackMode,
  visibleFiles,
} from './book-details-model';

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

describe('aboutContent', () => {
  const t = i18n.t.bind(i18n);
  const meta = {
    matched: true,
    work: { id: 'w', title: 'W', authors: [], language: 'en', description: ' The work. ' },
    web_url: 'https://m/w',
  } as MatchedBookMeta;
  const book = { title: 'W', author: 'A', narrator: 'N' };

  it('prefers the community text, then the server, then the work', () => {
    const shared = {
      ...meta,
      work: { ...meta.work, community_description: { text: ' Community. ' } },
    };
    expect(aboutContent({ ...book, description: 'Server.' }, shared, t)).toMatchObject({
      text: 'Community.',
      community: true,
    });
    expect(aboutContent({ ...book, description: 'Server.' }, meta, t)).toMatchObject({
      text: 'Server.',
      community: false,
    });
    expect(aboutContent({ ...book, description: '  ' }, meta, t).text).toBe('The work.');
  });

  it('names who wrote and reads an undescribed book, so it still reads complete', () => {
    expect(aboutContent(book, undefined, t).text).toBe('W by A, read by N.');
    expect(aboutContent({ ...book, narrator: '' }, undefined, t).text).toBe('W by A.');
    expect(aboutContent({ title: 'W', author: '', narrator: '' }, undefined, t).text).toBe(
      'No description yet.',
    );
  });

  it('lists only the production facts it knows', () => {
    const full = {
      ...meta,
      work: { ...meta.work, first_published: '1937' },
      recording: { id: 'r', narrators: [], publisher: 'P', release_date: '2012', abridged: false },
    } as MatchedBookMeta;
    expect(aboutContent({ ...book, published: '2010' }, full, t).details).toEqual([
      { label: 'Publisher', value: 'P' },
      { label: 'Released', value: '2012' },
      { label: 'First published', value: '1937' },
      { label: 'Abridged', value: 'No' },
    ]);
    expect(aboutContent({ ...book, published: '2010' }, undefined, t).details).toEqual([
      { label: 'Released', value: '2010' },
    ]);
    expect(aboutContent(book, undefined, t).details).toEqual([]);
  });
});
