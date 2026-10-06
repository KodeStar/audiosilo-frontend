import {
  addRecent,
  buildPaletteGroups,
  flattenGroups,
  isPaletteShortcut,
  matchRange,
  MAX_BOOKS,
  MAX_CONTINUE,
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

describe('addRecent', () => {
  it('puts the newest first, trimmed, de-duplicated ignoring case, at most five', () => {
    expect(addRecent([], '  holmes ')).toEqual(['holmes']);
    expect(addRecent(['holmes', 'alice'], 'Alice')).toEqual(['Alice', 'holmes']);
    expect(addRecent(['a', 'b', 'c', 'd', 'e'], 'f')).toEqual(['f', 'a', 'b', 'c', 'd']);
    expect(addRecent(['a'], '   ')).toEqual(['a']);
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
