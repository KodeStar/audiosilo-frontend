jest.mock('expo-router', () => ({ useSegments: () => [] }));

/* eslint-disable import/first */
import type { EditorRequest } from '@/components/annotations/editor-model';

import { dropsWithBook, editorFor, shownSheet, usePlayerSheets } from './player-sheets';
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
  it('shows an editor whatever is playing: it carries its own book', () => {
    expect(shownSheet('bookmark', edit, false)).toBe('bookmark');
    expect(shownSheet('note', newNote, false)).toBe('note');
    expect(editorFor('note', newNote)).toBe(newNote);
  });

  it("keeps a book's own sheets to a loaded book, Up next to any", () => {
    expect(shownSheet('speed', null, false)).toBeNull();
    expect(shownSheet('speed', null, true)).toBe('speed');
    expect(shownSheet('upnext', null, false)).toBe('upnext');
    // Without a request of its kind, `bookmark` is the add-here action (a book's).
    expect(shownSheet('bookmark', null, false)).toBeNull();
    expect(shownSheet('bookmark', newNote, true)).toBe('bookmark');
    expect(editorFor('bookmark', newNote)).toBeNull();
    expect(shownSheet('note', null, true)).toBeNull();
  });

  it('drops a book’s sheet with the book, never an editor', () => {
    expect(dropsWithBook('sleep', null)).toBe(true);
    expect(dropsWithBook('bookmark', null)).toBe(true);
    expect(dropsWithBook('bookmark', edit)).toBe(false);
    expect(dropsWithBook('note', newNote)).toBe(false);
    expect(dropsWithBook('upnext', null)).toBe(false);
    expect(dropsWithBook(null, edit)).toBe(false);
  });
});

describe('usePlayerSheets', () => {
  beforeEach(() => usePlayerSheets.setState({ open: null, editor: null }));

  it('opens an editor as its kind and keeps the request through the close', () => {
    usePlayerSheets.getState().openEditor(newNote);
    expect(usePlayerSheets.getState()).toMatchObject({ open: 'note', editor: newNote });
    usePlayerSheets.getState().close();
    // Kept for the closing animation, but nothing shows it any more.
    expect(usePlayerSheets.getState()).toMatchObject({ open: null, editor: newNote });
    expect(editorFor(usePlayerSheets.getState().open, newNote)).toBeNull();
  });

  it('forgets the editor when another sheet opens, so `bookmark` is the action again', () => {
    usePlayerSheets.getState().openEditor(edit);
    usePlayerSheets.getState().close();
    usePlayerSheets.getState().openSheet('bookmark');
    const { open, editor } = usePlayerSheets.getState();
    expect(editorFor(open, editor)).toBeNull();
  });
});
