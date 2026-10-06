import type { BookMetaCharacter, Chapter } from '@/api/types';

import {
  alsoOnServers,
  type CharacterBook,
  characterBooksToLoad,
  fold,
  hueSlot,
  initials,
  listeningIn,
  type ListSource,
  matchCharacters,
  matchNamed,
  matchRank,
} from './search-model';

const A: ListSource = { connectionId: 'a', connectionName: 'Home Library', libraryId: 1 };
const A2: ListSource = { connectionId: 'a', connectionName: 'Home Library', libraryId: 2 };
const B: ListSource = { connectionId: 'b', connectionName: "Maya's Shelf", libraryId: 1 };
const person = (name: string, books = 1) => ({ name, books, duration: 3600 });

describe('fold and matchRank', () => {
  it('ignores case and accents', () => {
    expect(fold('Émile ZOLA')).toBe('emile zola');
    expect(matchRank('Selma Lagerlöf', fold('lagerlof'))).toBe(1);
  });

  it('ranks a prefix, then a word start, then anywhere', () => {
    expect(matchRank('Jim Butcher', 'jim')).toBe(0);
    expect(matchRank('Jim Butcher', 'but')).toBe(1);
    expect(matchRank('Jim Butcher', 'tch')).toBe(2);
    expect(matchRank('Jim Butcher', 'zzz')).toBeNull();
    expect(matchRank('Jim Butcher', '')).toBeNull();
    // Regex characters in a query are literal.
    expect(matchRank('Ember & Ash (Book 1)', '(book')).toBe(1);
  });
});

describe('matchNamed', () => {
  it('matches across libraries and servers, one hit per name opening the first copy', () => {
    const hits = matchNamed(
      [
        { source: A, items: [person('Jim Butcher', 7), person('James S. A. Corey', 4)] },
        { source: A2, items: [person('jim butcher', 1)] },
        { source: B, items: [person('Jim Butcher', 1), person('Anna Jimenez', 9)] },
      ],
      'jim',
    );
    expect(hits.map((h) => h.name)).toEqual(['Jim Butcher', 'Anna Jimenez']);
    expect(hits[0]).toMatchObject({ books: 7, source: A, also: [A2, B] });
    expect(alsoOnServers(hits[0])).toEqual(["Maya's Shelf"]);
  });

  it('orders by match, then book count, then name, and caps', () => {
    const lists = [
      {
        source: A,
        items: [
          person('Ann Leckie', 2),
          person('Anne Rice', 5),
          person('Joanna Ann', 9),
          person('Dianne'),
        ],
      },
    ];
    expect(matchNamed(lists, 'ann').map((h) => h.name)).toEqual([
      'Anne Rice',
      'Ann Leckie',
      'Joanna Ann',
      'Dianne',
    ]);
    expect(matchNamed(lists, 'ann', 2)).toHaveLength(2);
    expect(matchNamed(lists, '   ')).toEqual([]);
  });
});

describe('characterBooksToLoad', () => {
  const row = (connectionId: string, path: string, position: number, finished = false) => ({
    connectionId,
    library_id: 1,
    path,
    position,
    finished,
    updated_at: '2026-10-01T00:00:00Z',
  });

  it('takes started and finished books on metadata servers, once each, capped', () => {
    const progress = [
      row('a', 'started', 100),
      row('a', 'unstarted', 0),
      row('b', 'no-meta', 100),
      row('a', 'finished', 0, true),
      row('a', 'started', 100),
      row('a', 'other', 50),
    ];
    const picks = characterBooksToLoad(progress, (cid) => cid === 'a', 2);
    expect(picks.map((p) => p.path)).toEqual(['started', 'finished']);
  });
});

describe('listeningIn', () => {
  const chapter = (start: number): Chapter => ({
    index: 0,
    title: '',
    file_index: 0,
    file_path: 'book.m4b',
    start,
    end: start + 100,
    book_offset: start,
  });
  const chapters = {
    chapters: [chapter(0), chapter(100), chapter(200), chapter(300)],
    files: [{ rel_path: 'book.m4b', duration: 400 } as never],
  };

  it("walks the saved place over the book's chapters", () => {
    expect(listeningIn({ progress: { position: 250, finished: false }, chapters })).toEqual({
      chapter: 3,
      finished: false,
    });
  });

  it('counts as not started until the chapters arrive (never reveals early)', () => {
    expect(listeningIn({ progress: { position: 350, finished: false } })).toEqual({
      chapter: 0,
      finished: false,
    });
  });

  it('takes the live place when it is further on, never when it is behind', () => {
    const progress = { position: 150, finished: false };
    expect(listeningIn({ progress, chapters, livePosition: 320 }).chapter).toBe(4);
    expect(listeningIn({ progress, chapters, livePosition: 10 }).chapter).toBe(2);
  });

  it('a finished book reveals everyone', () => {
    expect(listeningIn({ progress: { position: 0, finished: true } }).finished).toBe(true);
  });
});

describe('matchCharacters (spoiler safety)', () => {
  const ch = (
    id: string,
    name: string,
    chapter: number,
    aliases?: string[],
  ): BookMetaCharacter => ({
    id,
    name,
    aliases,
    role: 'supporting',
    reveal: { chapter },
  });
  // Caliban's War, listener in chapter 12 of 50.
  const calibans: CharacterBook = {
    connectionId: 'a',
    libraryId: 1,
    path: "Expanse/Caliban's War",
    title: "Caliban's War",
    listening: { chapter: 12, finished: false },
    characters: [
      ch('holden', 'James Holden', 1),
      ch('bobbie', 'Bobbie Draper', 1, ['Gunny']),
      ch('avasarala', 'Chrisjen Avasarala', 3),
      ch('prax', 'Praxidike Meng', 2, ['Prax']),
      ch('mei', 'Mei Meng', 40),
      ch('jules', 'Jules-Pierre Mao', 30, ['JPM']),
    ],
    attribution: {
      credit: 'AudioSilo Meta contributors',
      license: 'CC BY-SA 4.0',
      license_url: '',
      source_url: '',
    },
  };
  // Leviathan Wakes, finished: everyone met.
  const leviathan: CharacterBook = {
    connectionId: 'a',
    libraryId: 1,
    path: 'Expanse/Leviathan Wakes',
    title: 'Leviathan Wakes',
    listening: { chapter: 0, finished: true },
    characters: [ch('holden1', 'James Holden', 1), ch('julie', 'Julie Mao', 55)],
  };
  // Not started on paper (chapter 0): only the cast from the start.
  const unstarted: CharacterBook = {
    connectionId: 'b',
    libraryId: 1,
    path: "Expanse/Abaddon's Gate",
    title: "Abaddon's Gate",
    listening: { chapter: 0, finished: false },
    characters: [ch('anna', 'Anna Volovodov', 1), ch('clarissa', 'Clarissa Mao', 9)],
  };

  const names = (m: { hits: { name: string }[] }) => m.hits.map((h) => h.name);

  it('names only the characters reached, and counts the rest without naming them', () => {
    const m = matchCharacters([calibans], 'meng');
    expect(names(m)).toEqual(['Praxidike Meng']);
    expect(m.hidden).toBe(1);
    // Nothing in the result carries the unmet name.
    expect(JSON.stringify(m)).not.toContain('Mei');
    expect(m.hits[0]).toMatchObject({ bookTitle: "Caliban's War", path: "Expanse/Caliban's War" });
  });

  it('does not reveal an unmet character through an alias either', () => {
    const m = matchCharacters([calibans], 'jpm');
    expect(m.hits).toEqual([]);
    expect(m.hidden).toBe(1);
    expect(JSON.stringify(m)).not.toContain('Jules');
  });

  it('matches a met character by alias, after name matches', () => {
    expect(names(matchCharacters([calibans], 'gunny'))).toEqual(['Bobbie Draper']);
    expect(names(matchCharacters([calibans], 'pra'))).toEqual(['Praxidike Meng']);
  });

  it("gates each book by the listener's own place in it", () => {
    const m = matchCharacters([calibans, leviathan, unstarted], 'mao');
    // Julie Mao: met (Leviathan Wakes is finished). Jules-Pierre Mao: ch 30 of Caliban's
    // War, not reached. Clarissa Mao: ch 9 of an unstarted book, not reached.
    expect(names(m)).toEqual(['Julie Mao']);
    expect(m.hidden).toBe(2);
    expect(JSON.stringify(m)).not.toMatch(/Jules|Clarissa/);
  });

  it('shows a character met in two books once (the most recent), and never counts them hidden', () => {
    const m = matchCharacters([calibans, leviathan], 'holden');
    expect(m.hits).toHaveLength(1);
    expect(m.hits[0].bookTitle).toBe("Caliban's War");
    expect(m.hidden).toBe(0);
  });

  it('does not count a name as hidden when it was met in another book', () => {
    const later: CharacterBook = {
      ...unstarted,
      characters: [ch('julie2', 'Julie Mao', 30)],
    };
    const m = matchCharacters([leviathan, later], 'julie');
    expect(names(m)).toEqual(['Julie Mao']);
    expect(m.hidden).toBe(0);
  });

  it('caps the hits but not the hidden count, and credits the books shown', () => {
    const m = matchCharacters([calibans], 'a', 2);
    expect(m.hits).toHaveLength(2);
    expect(m.total).toBe(4);
    expect(m.hidden).toBe(1);
    expect(m.attributions).toEqual([calibans.attribution]);
  });

  it('finds nothing for an empty query', () => {
    expect(matchCharacters([calibans], '  ')).toEqual({
      hits: [],
      total: 0,
      hidden: 0,
      attributions: [],
    });
  });
});

describe('initials and hueSlot', () => {
  it('takes the first and last word', () => {
    expect(initials('James S. A. Corey')).toBe('JC');
    expect(initials('Naomi')).toBe('N');
    expect(initials('  ')).toBe('?');
    expect(initials('田中 晴美')).toBe('田晴');
  });

  it('is stable per name', () => {
    expect(hueSlot('Amos Burton')).toBe(hueSlot('Amos Burton'));
    expect(hueSlot('Amos Burton')).toBeGreaterThanOrEqual(0);
    expect(hueSlot('Amos Burton')).toBeLessThan(4);
  });
});
