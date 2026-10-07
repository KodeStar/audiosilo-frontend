jest.mock('expo-router', () => ({ useSegments: () => [] }));

/* eslint-disable import/first */
import type { EditorRequest } from '@/lib/annotation-request';

import { dropsWithBook, shownSheet, usePlayerSheets } from './player-sheets';
/* eslint-enable import/first */

const target = { connectionId: 'other', libraryId: 2, path: 'not/playing' };
const edit: EditorRequest = {
  kind: 'bookmark',
  target,
  position: 30,
  bookmark: {
    id: 1,
    library_id: 2,
    path: 'not/playing',
    position: 30,
    note: '',
    created_at: '2026-10-01T10:00:00Z',
  },
};
const newNote: EditorRequest = { kind: 'note', target, position: 12 };

describe('sheet routing', () => {
  it('shows the editor whatever is playing: it carries its own book', () => {
    expect(shownSheet('editor', false)).toBe('editor');
    expect(shownSheet('editor', true)).toBe('editor');
  });

  it("keeps a book's own sheets to a loaded book, Up next to any", () => {
    expect(shownSheet('speed', false)).toBeNull();
    expect(shownSheet('speed', true)).toBe('speed');
    expect(shownSheet('upnext', false)).toBe('upnext');
    // `bookmark` is the add-here action (a book's).
    expect(shownSheet('bookmark', false)).toBeNull();
    expect(shownSheet('bookmark', true)).toBe('bookmark');
  });

  it('drops a book’s sheet with the book, never the editor', () => {
    expect(dropsWithBook('sleep')).toBe(true);
    expect(dropsWithBook('bookmark')).toBe(true);
    expect(dropsWithBook('editor')).toBe(false);
    expect(dropsWithBook('upnext')).toBe(false);
    expect(dropsWithBook(null)).toBe(false);
  });
});

describe('usePlayerSheets', () => {
  beforeEach(() => usePlayerSheets.setState({ open: null, editor: null }));

  it('opens the editor on a request and keeps the request through the close', () => {
    usePlayerSheets.getState().openEditor(newNote);
    expect(usePlayerSheets.getState()).toMatchObject({ open: 'editor', editor: newNote });
    usePlayerSheets.getState().close();
    // Kept for the closing animation, but nothing shows it any more.
    expect(usePlayerSheets.getState()).toMatchObject({ open: null, editor: newNote });
  });

  it('forgets the editor when another sheet opens, so `bookmark` is the action again', () => {
    usePlayerSheets.getState().openEditor(edit);
    usePlayerSheets.getState().close();
    usePlayerSheets.getState().openSheet('bookmark');
    expect(usePlayerSheets.getState()).toMatchObject({ open: 'bookmark', editor: null });
  });
});
