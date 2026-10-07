import i18n from '@/i18n';

import {
  type ActionRuns,
  type ActionState,
  buildActionItems,
  buildPaletteGroups,
  flattenGroups,
  isPaletteShortcut,
  matchRange,
  MAX_BOOKS,
  MAX_CONTINUE,
  MAX_NAMED,
  moveSelection,
  type PaletteItem,
  shortcutHint,
} from './palette-model';

const item = (id: string, title: string, subtitle?: string): PaletteItem => ({
  id,
  title,
  subtitle,
  run: jest.fn(),
});

const actions = [
  item('toggle', 'Resume Chapter 3', 'The Hound of the Baskervilles'),
  item('sleep', 'Sleep in 30 minutes', 'Fades out over the last 30 seconds'),
  item('settings', 'Go to settings', 'Servers, appearance and playback'),
];
const goTo = [item('home', 'Home'), item('library', 'Library'), item('downloads', 'Downloads')];
const books = Array.from({ length: 12 }, (_, i) => item(`b${i}`, `Holmes ${i}`));
const continueListening = Array.from({ length: 6 }, (_, i) => item(`c${i}`, `Book ${i}`));

describe('buildPaletteGroups', () => {
  it('shows every action, Continue listening and Go to on an empty query', () => {
    const groups = buildPaletteGroups({ query: '  ', actions, books, continueListening, goTo });
    expect(groups.map((g) => g.key)).toEqual(['actions', 'continue', 'goTo']);
    expect(groups[0].items).toHaveLength(3);
    expect(groups[1].items).toHaveLength(MAX_CONTINUE);
  });

  it('filters actions by title or subtitle, keeps the server results, filters Go to', () => {
    const groups = buildPaletteGroups({ query: 'sleep', actions, books, continueListening, goTo });
    expect(groups.map((g) => g.key)).toEqual(['actions', 'books']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['sleep']);
    expect(groups[1].items).toHaveLength(MAX_BOOKS);

    const bySubtitle = buildPaletteGroups({
      query: 'hound',
      actions,
      books: [],
      continueListening,
      goTo,
    });
    expect(bySubtitle.map((g) => g.key)).toEqual(['actions']);
    expect(bySubtitle[0].items[0].id).toBe('toggle');

    const lib = buildPaletteGroups({ query: 'LIB', actions, books: [], continueListening, goTo });
    expect(lib.map((g) => [g.key, g.items.map((i) => i.id)])).toEqual([['goTo', ['library']]]);
  });

  it('drops every group when nothing matches', () => {
    expect(
      buildPaletteGroups({ query: 'zzz', actions, books: [], continueListening, goTo }),
    ).toEqual([]);
  });

  it('flattens the groups in display order (the listbox numbering)', () => {
    const groups = buildPaletteGroups({ query: '', actions, books, continueListening, goTo });
    const flat = flattenGroups(groups);
    expect(flat[0].id).toBe('toggle');
    expect(flat[3].id).toBe('c0');
    expect(flat[flat.length - 1].id).toBe('downloads');
  });

  it("numbers each group's first item in the flat list", () => {
    const groups = buildPaletteGroups({ query: '', actions, books, continueListening, goTo });
    const flat = flattenGroups(groups);
    for (const g of groups) {
      g.items.forEach((it, i) => expect(flat[g.start + i]).toBe(it));
    }
    expect(groups.map((g) => g.start)).toEqual([0, 3, 3 + MAX_CONTINUE]);
  });
});

describe('buildPaletteGroups: series, people and characters', () => {
  const series = Array.from({ length: 5 }, (_, i) => item(`s${i}`, `Series ${i}`));
  const authors = [item('a0', 'Jim Butcher')];
  const narrators = [item('n0', 'James Marsters')];
  const characters = [item('c0', 'Harry Dresden')];

  it('adds them after Books, in order, capped, only with a query', () => {
    const groups = buildPaletteGroups({
      query: 'har',
      actions: [],
      books: [item('b', 'Storm Front')],
      continueListening,
      series,
      authors,
      narrators,
      characters,
      goTo: [],
    });
    expect(groups.map((g) => g.key)).toEqual([
      'books',
      'series',
      'authors',
      'narrators',
      'characters',
    ]);
    expect(groups[1].items).toHaveLength(MAX_NAMED);
    expect(groups.map((g) => g.start)).toEqual([0, 1, 1 + MAX_NAMED, 2 + MAX_NAMED, 3 + MAX_NAMED]);

    const empty = buildPaletteGroups({
      query: '',
      actions: [],
      books: [],
      continueListening: [],
      series,
      authors,
      narrators,
      characters,
      charactersNote: '2 more',
      goTo: [],
    });
    expect(empty).toEqual([]);
  });

  it('keeps Characters for its unmet count alone, which is not an option', () => {
    const groups = buildPaletteGroups({
      query: 'jas',
      actions: [],
      books: [],
      continueListening,
      characters: [],
      charactersNote: '1 more match after your place in the book',
      goTo,
    });
    expect(groups).toEqual([
      {
        key: 'characters',
        items: [],
        note: '1 more match after your place in the book',
        start: 0,
      },
    ]);
    expect(flattenGroups(groups)).toEqual([]);
  });
});

describe('matchRange', () => {
  it('finds the first case-insensitive match, or nothing', () => {
    expect(matchRange('The Adventures of Sherlock Holmes', 'holmes')).toEqual([27, 33]);
    expect(matchRange('Holmes and holmes', 'HOLMES')).toEqual([0, 6]);
    expect(matchRange('Alice', 'holmes')).toBeNull();
    expect(matchRange('Alice', '  ')).toBeNull();
  });
});

describe('moveSelection', () => {
  it('moves by one and clamps at both ends', () => {
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(2, 1, 3)).toBe(2);
    expect(moveSelection(0, -1, 3)).toBe(0);
    expect(moveSelection(5, 0, 0)).toBe(0);
  });
});

describe('isPaletteShortcut', () => {
  const key = (
    k: string,
    mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey', boolean>> = {},
  ) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...mods,
  });

  it('opens on ⌘K, Ctrl+K and a bare slash', () => {
    expect(isPaletteShortcut(key('k', { metaKey: true }), false)).toBe(true);
    expect(isPaletteShortcut(key('K', { ctrlKey: true }), false)).toBe(true);
    expect(isPaletteShortcut(key('/'), false)).toBe(true);
  });

  it('never fires while typing, and ignores other keys and modifiers', () => {
    expect(isPaletteShortcut(key('/'), true)).toBe(false);
    expect(isPaletteShortcut(key('k', { metaKey: true }), true)).toBe(false);
    expect(isPaletteShortcut(key('k'), false)).toBe(false);
    expect(isPaletteShortcut(key('k', { metaKey: true, altKey: true }), false)).toBe(false);
    expect(isPaletteShortcut(key('/', { ctrlKey: true }), false)).toBe(false);
  });
});

describe('shortcutHint', () => {
  it('says ⌘K on Apple platforms and Ctrl K elsewhere', () => {
    expect(shortcutHint('MacIntel')).toBe('⌘K');
    expect(shortcutHint('macOS')).toBe('⌘K');
    expect(shortcutHint('Win32')).toBe('Ctrl K');
    expect(shortcutHint('')).toBe('Ctrl K');
  });
});

describe('buildActionItems', () => {
  const runs = (): ActionRuns => ({
    toggle: jest.fn(),
    sleepMinutes: jest.fn(),
    sleepChapter: jest.fn(),
    player: jest.fn(),
    upNext: jest.fn(),
    settings: jest.fn(),
    appearance: jest.fn(),
  });
  const state = (over: Partial<ActionState> = {}): ActionState => ({
    nowPlaying: { title: 'A Christmas Carol', chapterName: 'Stave One', hasChapters: true },
    isPlaying: false,
    sleepMinutes: 30,
    upNext: null,
    dark: false,
    ...over,
  });
  const ids = (s: ActionState) => buildActionItems(s, runs(), i18n.t).map((i) => i.id);

  it('offers the transport, the sleep timer and the player only with a book loaded', () => {
    expect(ids(state())).toEqual([
      'toggle',
      'sleep-minutes',
      'sleep-chapter',
      'player',
      'settings',
      'appearance',
    ]);
    expect(ids(state({ nowPlaying: null }))).toEqual(['settings', 'appearance']);
  });

  it('offers end of chapter only for a book with real chapters', () => {
    const np = { title: 'Notes', chapterName: null, hasChapters: false };
    expect(ids(state({ nowPlaying: np }))).not.toContain('sleep-chapter');
  });

  it('offers Up next where it is supported, with the queued count, and runs openUpNext', () => {
    const r = runs();
    const items = buildActionItems(state({ nowPlaying: null, upNext: { count: 1 } }), r, i18n.t);
    expect(items.map((i) => i.id)).toEqual(['up-next', 'settings', 'appearance']);
    expect(items[0]).toMatchObject({ title: 'Open Up next', subtitle: '1 book queued' });
    items[0].run();
    expect(r.upNext).toHaveBeenCalledTimes(1);
  });

  it('names the pause or the chapter to resume, and the theme to switch to', () => {
    const playing = buildActionItems(state({ isPlaying: true, dark: true }), runs(), i18n.t);
    expect(playing[0].title).toBe('Pause');
    expect(playing.at(-1)?.title).toBe('Switch to light appearance');
    expect(buildActionItems(state(), runs(), i18n.t)[0].title).toBe('Resume Stave One');
  });
});
