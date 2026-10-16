import i18n from '@/i18n';

import {
  aboutContent,
  bookPublisher,
  fileRows,
  FILES_SHOWN,
  labelGroups,
  languageName,
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
  const work = { id: 'w', title: 'W', authors: [], language: 'en', description: ' The work. ' };
  const book = { title: 'W', author: 'A', narrator: 'N' };
  // A description generated on this server (Bridge 1c), as the server sends it.
  const generated = {
    generated: { description: true },
    generated_description: { text: ' Written here. ' },
  };

  // Each work carries a generated description too: it never outranks the others.
  it('prefers the community text, then the server, then the work, then the generated one', () => {
    const shared = { ...work, ...generated, community_description: { text: ' Community. ' } };
    expect(aboutContent({ ...book, description: 'Server.' }, shared, undefined, t)).toMatchObject({
      text: 'Community.',
      source: 'community',
    });
    // Also where nothing else would have stood in the generated text's way.
    expect(aboutContent(book, { ...shared, description: undefined }, undefined, t)).toMatchObject({
      text: 'Community.',
      source: 'community',
    });
    expect(
      aboutContent({ ...book, description: 'Server.' }, { ...work, ...generated }, undefined, t),
    ).toMatchObject({ text: 'Server.', source: 'own' });
    expect(
      aboutContent({ ...book, description: '  ' }, { ...work, ...generated }, undefined, t),
    ).toMatchObject({ text: 'The work.', source: 'own' });
  });

  describe('a description generated on this server (Bridge 1c)', () => {
    it('leads when nothing else describes the book, matched or not', () => {
      expect(
        aboutContent(book, { ...work, ...generated, description: undefined }, undefined, t),
      ).toMatchObject({ text: 'Written here.', source: 'generated' });
      // An unmatched book: only the work its server generated.
      const unmatched = { id: '', title: 'W', authors: [], language: '', ...generated };
      expect(aboutContent(book, unmatched, undefined, t)).toMatchObject({
        text: 'Written here.',
        source: 'generated',
      });
    });

    it('needs the generated flag and a non-blank text, else the fallback sentence', () => {
      const fallback = { text: 'W by A, read by N.', source: 'fallback' };
      const noFlag = { generated: { characters: true }, generated_description: { text: 'X.' } };
      expect(aboutContent(book, noFlag, undefined, t)).toMatchObject(fallback);
      const blank = { generated: { description: true }, generated_description: { text: '  ' } };
      expect(aboutContent(book, blank, undefined, t)).toMatchObject(fallback);
      const missing = { generated: { description: true } };
      expect(aboutContent(book, missing, undefined, t)).toMatchObject(fallback);
      expect(aboutContent(book, undefined, undefined, t)).toMatchObject(fallback);
    });
  });

  it('names who wrote and reads an undescribed book, so it still reads complete', () => {
    expect(aboutContent(book, undefined, undefined, t).text).toBe('W by A, read by N.');
    expect(aboutContent({ ...book, narrator: '' }, undefined, undefined, t).text).toBe('W by A.');
    expect(
      aboutContent({ title: 'W', author: '', narrator: '' }, undefined, undefined, t).text,
    ).toBe('No description yet.');
  });

  it('lists only the production facts it knows', () => {
    const recording = { publisher: 'P', release_date: '2012', abridged: false };
    // The community's abridged false is also its "not recorded": no row.
    expect(
      aboutContent(
        { ...book, published: '2010' },
        { ...work, first_published: '1937' },
        recording,
        t,
      ).details,
    ).toEqual([
      { label: 'Publisher', value: 'P' },
      { label: 'Released', value: '2012' },
      { label: 'First published', value: '1937' },
    ]);
    expect(aboutContent({ ...book, published: '2010' }, undefined, undefined, t).details).toEqual([
      { label: 'Released', value: '2010' },
    ]);
    expect(aboutContent(book, undefined, undefined, t).details).toEqual([]);
  });

  it("lists the server's publisher, language and abridged, before the community's", () => {
    const recording = { publisher: 'Community P', abridged: true };
    const own = { ...book, publisher: ' Server P ', language: 'English', abridged: false };
    expect(aboutContent(own, work, recording, t).details).toEqual([
      { label: 'Publisher', value: 'Server P' },
      { label: 'Language', value: 'English' },
      { label: 'Abridged', value: 'No' },
    ]);
    // Abridged is three-state: true, false, and absent (unknown, so no row at all).
    expect(aboutContent({ ...book, abridged: true }, undefined, undefined, t).details).toEqual([
      { label: 'Abridged', value: 'Yes' },
    ]);
    expect(aboutContent({ ...book, abridged: false }, undefined, undefined, t).details).toEqual([
      { label: 'Abridged', value: 'No' },
    ]);
    expect(aboutContent({ ...book, abridged: undefined }, undefined, undefined, t).details).toEqual(
      [],
    );
    // Unknown on the server: the community's answer stands.
    expect(aboutContent({ ...book, publisher: '  ' }, work, recording, t).details).toEqual([
      { label: 'Publisher', value: 'Community P' },
      { label: 'Abridged', value: 'Yes' },
    ]);
  });

  it("carries the book's genres, then its tags, only the kinds it has", () => {
    expect(aboutContent(book, undefined, undefined, t).labels).toEqual([]);
    expect(
      aboutContent({ ...book, genres: ['Fantasy'], tags: ['to-read'] }, undefined, undefined, t)
        .labels,
    ).toEqual([
      { kind: 'genre', names: ['Fantasy'] },
      { kind: 'tag', names: ['to-read'] },
    ]);
  });
});

describe('labelGroups', () => {
  it("groups the server's lists as they come, each kind only when it has some", () => {
    expect(labelGroups({ genres: ['Fantasy', 'Epic Fantasy'], tags: [] })).toEqual([
      { kind: 'genre', names: ['Fantasy', 'Epic Fantasy'] },
    ]);
    expect(labelGroups({ tags: ['a'] })).toEqual([{ kind: 'tag', names: ['a'] }]);
    expect(labelGroups({})).toEqual([]);
  });
});

describe('bookPublisher', () => {
  const recording = { publisher: 'Community P' };
  it("is the server's own publisher, else the community recording's", () => {
    expect(bookPublisher({ publisher: ' Server P ' }, recording)).toBe('Server P');
    expect(bookPublisher({ publisher: '  ' }, recording)).toBe('Community P');
    expect(bookPublisher({}, undefined)).toBeUndefined();
  });
});

describe('languageName', () => {
  it('names a language code where the platform can, else keeps the value', () => {
    expect(languageName('English', 'en')).toBe('English');
    expect(languageName(' fr ', 'en')).toBe('French');
    expect(languageName('eng', 'en')).toBe('English');
    // Capitalised as a row value ("allemand" in running French text).
    expect(languageName('de', 'fr')).toBe('Allemand');
    expect(languageName('zz-not-a-code!', 'en')).toBe('zz-not-a-code!');
  });

  it('keeps the value without Intl.DisplayNames (Hermes may lack it)', () => {
    const intl = Intl as { DisplayNames?: unknown };
    const saved = intl.DisplayNames;
    intl.DisplayNames = undefined;
    try {
      expect(languageName('en', 'en')).toBe('en');
    } finally {
      intl.DisplayNames = saved;
    }
  });
});
