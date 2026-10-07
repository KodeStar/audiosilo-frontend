import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import type { Book, Bookmark, Note } from '@/api/types';

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useSegments: () => [] }));
let mockAnnotations: boolean | undefined = true;
const mockDeleteBookmark = jest.fn();
const mockDeleteNote = jest.fn();
const mockAddBookmark = jest.fn((..._a: unknown[]) => Promise.resolve({}));
const mockAddNote = jest.fn((..._a: unknown[]) => Promise.resolve({}));
jest.mock('@/api/hooks', () => ({
  useCapability: () => mockAnnotations,
  useDeleteBookmark: () => ({ mutate: mockDeleteBookmark }),
  useDeleteNote: () => ({ mutate: mockDeleteNote }),
  addBookmark: (...a: unknown[]) => mockAddBookmark(...a),
  addNote: (...a: unknown[]) => mockAddNote(...a),
}));
// Where a jump goes is the one play path's (`playRoute`, its own table).
const mockPlay = jest.fn((..._a: unknown[]) => Promise.resolve());
jest.mock('@/components/player/use-play-book', () => ({ usePlayBook: () => mockPlay }));
jest.mock('@/components/ui/toast', () => ({ toast: jest.fn() }));
// The cover's own server lookups are not what these rows test.
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
const mockOpenBook = jest.fn();
jest.mock('@/lib/open', () => ({ useOpen: () => ({ openBook: mockOpenBook }) }));
let mockLayout = 'phone';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
// The markdown renderer ships ESM jest can't load: render the body as plain text.
jest.mock('react-native-marked', () => {
  const { Text: T } = jest.requireActual('react-native');
  return { useMarkdown: (body: string) => [<T key="md">{body}</T>] };
});

/* eslint-disable import/first */
import { usePlayerSheets } from '@/components/player/player-sheets';
import { toast } from '@/components/ui/toast';
import { expectNativeTarget } from '@/testing/touch-target';
import { colors } from '@/theme/tokens';

import { BookmarkRow } from './bookmark-row';
import { LabelPicker } from './chips';
import { NoteRow } from './note-row';
import { RowCover, ServerFlag } from './row-parts';
/* eslint-enable import/first */

const MADE = new Date(Date.now() - 3 * 86_400_000).toISOString();

const bookmark = (over: Partial<Bookmark> = {}): Bookmark => ({
  id: 7,
  library_id: 1,
  path: 'a/book',
  position: 62_810,
  note: 'Bridge Four starts to become a crew.',
  label: '',
  created_at: MADE,
  ...over,
});

const note = (over: Partial<Note> = {}): Note => ({
  id: 9,
  library_id: 1,
  path: 'a/book',
  position: 37_200,
  body: 'Theory: Syl is not a windspren.',
  created_at: MADE,
  updated_at: MADE,
  ...over,
});

/** react-native-svg's processed colour: ARGB as one number (`#123456` -> 0xff123456). */
const argb = (hex: string) => parseInt(`ff${hex.slice(1)}`, 16);

/** Every glyph colour drawn inside the element with `testID`, as `#rrggbb`. */
function tintsIn(testID: string): string[] {
  type Node = { props?: Record<string, unknown>; children?: (Node | string)[] | null };
  const find = (n: Node | string | null): Node | null => {
    if (!n || typeof n === 'string') return null;
    if (n.props?.testID === testID) return n;
    for (const c of n.children ?? []) {
      const hit = find(c);
      if (hit) return hit;
    }
    return null;
  };
  const fills: number[] = [];
  const walk = (n: Node | string) => {
    if (typeof n === 'string') return;
    const fill = n.props?.fill as { payload?: number } | undefined;
    if (n.props?.d && typeof fill?.payload === 'number') fills.push(fill.payload);
    (n.children ?? []).forEach(walk);
  };
  const root = screen.toJSON() as Node | Node[] | null;
  const hit = Array.isArray(root) ? root.map(find).find(Boolean) : find(root);
  if (hit) walk(hit);
  const known = [
    colors.light.mutedForeground,
    colors.dark.mutedForeground,
    colors.light.destructive,
    colors.dark.destructive,
  ];
  return fills.map((f) => known.find((c) => argb(c) === f) ?? `other:${f}`);
}

const OS = Platform.OS;

beforeEach(() => {
  jest.clearAllMocks();
  mockAnnotations = true;
  mockLayout = 'phone';
  usePlayerSheets.setState({ open: null, editor: null });
  Platform.OS = OS;
});
afterAll(() => {
  Platform.OS = OS;
});

describe('BookmarkRow', () => {
  it('shows the time, the label and the note, the chapter and the age', async () => {
    await render(
      <BookmarkRow
        bookmark={bookmark({ label: 'favourite' })}
        connectionId="c"
        chapter="21. A Bloody, Red Sunset"
      />,
    );
    expect(screen.getByRole('button', { name: 'Jump to 17:26:50' })).toBeTruthy();
    expect(screen.getByText('Favourite')).toBeTruthy();
    expect(screen.getByText('Bridge Four starts to become a crew.')).toBeTruthy();
    expect(screen.getByText(/^21\. A Bloody, Red Sunset · /)).toBeTruthy();
  });

  it('sets a Quote as a quotation, in italics', async () => {
    await render(
      <BookmarkRow
        bookmark={bookmark({ label: 'quote', note: 'Life before death.' })}
        connectionId="c"
      />,
    );
    const quote = screen.getByTestId('bookmark-quote');
    expect(quote).toHaveTextContent('“Life before death.”');
    expect(String(quote.props.className)).toContain('italic');
  });

  it('reads the sleep timer’s bookmark as a drift marker, on an older server too', async () => {
    // An older server: no label, the note in the language it was made in.
    await render(
      <BookmarkRow
        bookmark={bookmark({ label: undefined, note: 'Eingeschlafen' })}
        connectionId="c"
      />,
    );
    expect(screen.getByText('Fell asleep')).toBeTruthy();
    expect(screen.getByText('You drifted off around here')).toBeTruthy();
    expect(screen.queryByText('Eingeschlafen')).toBeNull();
  });

  it('says quietly when a bookmark has no note', async () => {
    await render(<BookmarkRow bookmark={bookmark({ note: '' })} connectionId="c" />);
    expect(screen.getByText('No note')).toBeTruthy();
  });

  it('offers Edit only where the server takes edits, naming what it acts on', async () => {
    mockAnnotations = false;
    const view = await render(<BookmarkRow bookmark={bookmark()} connectionId="c" />);
    expect(screen.queryByRole('button', { name: 'Edit bookmark at 17:26:50' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete bookmark at 17:26:50' })).toBeTruthy();
    mockAnnotations = true;
    await view.rerender(<BookmarkRow bookmark={bookmark()} connectionId="c" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Edit bookmark at 17:26:50' }));
    expect(usePlayerSheets.getState()).toMatchObject({
      open: 'editor',
      editor: {
        kind: 'bookmark',
        target: { connectionId: 'c', libraryId: 1, path: 'a/book' },
        position: 62_810,
        bookmark: bookmark(),
      },
    });
  });

  it('deletes at once, with an Undo that puts the same bookmark back', async () => {
    const bm = bookmark({ label: 'quote', note: 'Life before death.' });
    await render(<BookmarkRow bookmark={bm} connectionId="c" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Delete bookmark at 17:26:50' }));
    expect(mockDeleteBookmark).toHaveBeenCalledWith(7, expect.anything());
    mockDeleteBookmark.mock.calls[0][1].onSuccess();
    const shown = (toast as jest.Mock).mock.calls[0][0];
    expect(shown).toMatchObject({ title: 'Bookmark deleted', description: '17:26:50' });
    expect(shown.action.label).toBe('Undo');
    shown.action.onPress();
    expect(mockAddBookmark).toHaveBeenCalledWith(
      'c',
      1,
      'a/book',
      62_810,
      'Life before death.',
      'quote',
    );
  });

  it('jumps through the one play path, and says so when the book cannot start', async () => {
    mockPlay.mockRejectedValueOnce(new Error('offline'));
    await render(<BookmarkRow bookmark={bookmark()} connectionId="c" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Jump to 17:26:50' }));
    expect(mockPlay).toHaveBeenCalledWith(
      { connectionId: 'c', libraryId: 1, path: 'a/book' },
      { at: { position: 62_810 } },
    );
    await Promise.resolve();
    expect(toast).toHaveBeenCalledWith({ title: "Couldn't start the book there" });
  });

  it('takes the caller’s jump when given (the companion)', async () => {
    const onJump = jest.fn();
    await render(<BookmarkRow bookmark={bookmark()} connectionId="c" onJump={onJump} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Jump to 17:26:50' }));
    expect(onJump).toHaveBeenCalledWith(62_810);
    expect(mockPlay).not.toHaveBeenCalled();
  });

  it('names and opens its book in a list across books (the Journal)', async () => {
    const book = { library_id: 1, rel_path: 'a/book', title: 'The Way of Kings' } as Book;
    await render(<BookmarkRow bookmark={bookmark()} connectionId="c" book={book} />);
    expect(screen.getByText(/^The Way of Kings · /)).toBeTruthy();
    await fireEvent.press(screen.getByRole('link', { name: 'The Way of Kings' }));
    expect(mockOpenBook).toHaveBeenCalledWith('c', 1, 'a/book', 'bookmarks');
  });

  it('keeps Edit and Delete quiet: muted glyphs, never the destructive colour on a row', async () => {
    await render(<BookmarkRow bookmark={bookmark()} connectionId="c" />);
    for (const id of ['bookmark-edit', 'bookmark-delete']) {
      const tints = tintsIn(id);
      expect(tints.length).toBeGreaterThan(0);
      expect([colors.light.mutedForeground, colors.dark.mutedForeground]).toContain(tints[0]);
      expect(tints).not.toContain(colors.light.destructive);
      expect(tints).not.toContain(colors.dark.destructive);
    }
  });

  it('names its server in a list across several servers, and not otherwise', async () => {
    const view = await render(
      <BookmarkRow bookmark={bookmark()} connectionId="c" server="Maya's Shelf" />,
    );
    expect(screen.getByTestId('row-server')).toBeTruthy();
    expect(screen.getByText("Maya's Shelf")).toBeTruthy();
    await view.rerender(<BookmarkRow bookmark={bookmark()} connectionId="c" />);
    expect(screen.queryByTestId('row-server')).toBeNull();
  });

  // WDA measured the edit and delete icons at 32 x 32 pt on an iPhone: a slop grows the
  // touch but not the control's own frame, so on native the frame itself is 44 pt.
  it('gives every control a real 44 pt frame on native, not just a slop', async () => {
    Platform.OS = 'ios';
    await render(<BookmarkRow bookmark={bookmark()} connectionId="c" />);
    for (const name of [
      'Jump to 17:26:50',
      'Edit bookmark at 17:26:50',
      'Delete bookmark at 17:26:50',
    ]) {
      const control = screen.getByRole('button', { name });
      expect(control.props.hitSlop).toBeUndefined();
      expectNativeTarget(control);
    }
  });
});

describe('NoteRow', () => {
  it('pins its time in the community colour and renders the body', async () => {
    await render(<NoteRow note={note()} connectionId="c" chapter="23. Bridge Four" />);
    const chip = screen.getByRole('button', { name: 'Jump to 10:20:00' });
    expect(chip).toBeTruthy();
    expect(String(screen.getByText('10:20:00').props.className)).toContain('text-community');
    expect(screen.getByText(/Syl is not a windspren/)).toBeTruthy();
  });

  it('keeps Delete quiet and names its server when given one', async () => {
    await render(<NoteRow note={note()} connectionId="c" server="Maya's Shelf" />);
    const tints = tintsIn('note-delete');
    expect(tints).not.toContain(colors.light.destructive);
    expect(tints).not.toContain(colors.dark.destructive);
    expect(screen.getByText("Maya's Shelf")).toBeTruthy();
  });

  it('shows a note made before notes had places at 0:00', async () => {
    await render(<NoteRow note={note({ position: 0 })} connectionId="c" />);
    expect(screen.getByRole('button', { name: 'Jump to 0:00' })).toBeTruthy();
  });

  it('edits through the editor (keeping its place) and deletes with Undo', async () => {
    await render(<NoteRow note={note()} connectionId="c" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Edit note at 10:20:00' }));
    expect(usePlayerSheets.getState()).toMatchObject({
      open: 'editor',
      editor: { kind: 'note', position: 37_200, note: note() },
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Delete note at 10:20:00' }));
    mockDeleteNote.mock.calls[0][1].onSuccess();
    (toast as jest.Mock).mock.calls[0][0].action.onPress();
    expect(mockAddNote).toHaveBeenCalledWith(
      'c',
      1,
      'a/book',
      'Theory: Syl is not a windspren.',
      37_200,
    );
  });

  it('offers no Edit on a server without annotations', async () => {
    mockAnnotations = false;
    await render(<NoteRow note={note()} connectionId="c" />);
    expect(screen.queryByRole('button', { name: 'Edit note at 10:20:00' })).toBeNull();
  });
});

describe('row parts the Diary shares', () => {
  const book = { library_id: 1, rel_path: 'a/book', title: 'The Way of Kings' } as Book;

  it('names a cover link by its book, or as the caller says', async () => {
    const onOpen = jest.fn();
    const view = await render(<RowCover connectionId="c" book={book} onOpen={onOpen} />);
    await fireEvent.press(screen.getByRole('link', { name: 'The Way of Kings' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    await view.rerender(
      <RowCover
        connectionId="c"
        book={book}
        onOpen={onOpen}
        accessibilityLabel="Open The Way of Kings"
      />,
    );
    expect(screen.getByRole('link', { name: 'Open The Way of Kings' })).toBeTruthy();
  });

  it('flags a server by its name', async () => {
    await render(<ServerFlag name="Maya's Shelf" />);
    expect(screen.getByTestId('row-server')).toBeTruthy();
    expect(screen.getByText("Maya's Shelf")).toBeTruthy();
  });
});

describe('LabelPicker', () => {
  it('is a single-select group: one label or none, tap again to clear', async () => {
    const onChange = jest.fn();
    const view = await render(<LabelPicker value="" onChange={onChange} />);
    expect(screen.getByLabelText('Label').props.role).toBe('radiogroup');
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.props.accessibilityLabel)).toEqual([
      'Quote',
      'Favourite',
      'Re-listen',
      'Funny',
      'Question',
    ]);
    await fireEvent.press(screen.getByRole('radio', { name: 'Funny' }));
    expect(onChange).toHaveBeenLastCalledWith('funny');
    await view.rerender(<LabelPicker value="funny" onChange={onChange} />);
    expect(screen.getByRole('radio', { name: 'Funny' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Quote' })).not.toBeChecked();
    await fireEvent.press(screen.getByRole('radio', { name: 'Funny' }));
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('gives each chip a real 44 pt frame on native', async () => {
    Platform.OS = 'android';
    await render(<LabelPicker value="" onChange={() => {}} />);
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio.props.hitSlop).toBeUndefined();
      expectNativeTarget(radio);
    }
  });
});
