import type { Bookmark, Note } from '@/api/types';

import {
  bookmarkSave,
  editBookmarkRequest,
  editNoteRequest,
  initialBookmarkDraft,
  noteSave,
} from './editor-model';

const bookmark = (over: Partial<Bookmark> = {}): Bookmark => ({
  id: 7,
  library_id: 1,
  path: 'a/book',
  position: 62_810,
  note: 'Bridge Four',
  label: 'favourite',
  created_at: '2026-10-01T10:00:00Z',
  ...over,
});

const note = (over: Partial<Note> = {}): Note => ({
  id: 9,
  library_id: 1,
  path: 'a/book',
  position: 37_200,
  body: 'Track the **Parshendi**',
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-01T10:00:00Z',
  ...over,
});

const target = { connectionId: 'c', libraryId: 1, path: 'a/book' };

describe('bookmarkSave: a new bookmark', () => {
  it('sends the note and the label to a server with annotations', () => {
    expect(
      bookmarkSave({ position: 62_810.4 }, { note: '  A quote ', label: 'quote' }, true),
    ).toEqual({ kind: 'add', vars: { position: 62_810, note: 'A quote', label: 'quote' } });
  });

  // The add hook is the one owner of the label's gate (`useAddBookmark`, tested in
  // hooks-capability: no label to a server without annotations, or one not known yet).
  it('leaves the label to the add hook, whatever the server; never one it does not offer', () => {
    for (const annotations of [false, undefined]) {
      expect(bookmarkSave({ position: 5 }, { note: 'x', label: 'quote' }, annotations)).toEqual({
        kind: 'add',
        vars: { position: 5, note: 'x', label: 'quote' },
      });
    }
    expect(bookmarkSave({ position: 5 }, { note: 'x', label: 'shiny' }, true)).toEqual({
      kind: 'add',
      vars: { position: 5, note: 'x' },
    });
  });

  it('sends no label when none is picked', () => {
    expect(bookmarkSave({ position: 5 }, { note: '', label: '' }, true)).toEqual({
      kind: 'add',
      vars: { position: 5, note: '' },
    });
  });
});

describe('bookmarkSave: an edit', () => {
  const request = { position: 62_810, bookmark: bookmark() };

  it('needs annotations: an older server (or one not known yet) cannot take it', () => {
    const draft = { note: 'changed', label: 'favourite' };
    expect(bookmarkSave(request, draft, false)).toEqual({ kind: 'unsupported' });
    expect(bookmarkSave(request, draft, undefined)).toEqual({ kind: 'unsupported' });
  });

  it('sends only what changed', () => {
    expect(
      bookmarkSave(request, { note: 'Bridge Four, again ', label: 'favourite' }, true),
    ).toEqual({ kind: 'update', patch: { id: 7, note: 'Bridge Four, again' } });
    expect(bookmarkSave(request, { note: 'Bridge Four', label: 'quote' }, true)).toEqual({
      kind: 'update',
      patch: { id: 7, label: 'quote' },
    });
  });

  it("clears the label with ''", () => {
    expect(bookmarkSave(request, { note: 'Bridge Four', label: '' }, true)).toEqual({
      kind: 'update',
      patch: { id: 7, label: '' },
    });
  });

  it('changes nothing for an untouched draft, even an unknown label or untrimmed note', () => {
    const odd = bookmark({ label: 'from_the_future', note: 'spaced ' });
    expect(bookmarkSave({ position: 1, bookmark: odd }, initialBookmarkDraft(odd), true)).toEqual({
      kind: 'unchanged',
    });
    // An older server's bookmark has no label at all.
    const old = bookmark({ label: undefined });
    expect(bookmarkSave({ position: 1, bookmark: old }, initialBookmarkDraft(old), true)).toEqual({
      kind: 'unchanged',
    });
  });

  it('keeps the drift marker’s label when only its note changes', () => {
    const drift = bookmark({ label: 'fell_asleep', note: 'Fell asleep' });
    const draft = { ...initialBookmarkDraft(drift), note: 'Around the duel' };
    expect(bookmarkSave({ position: 1, bookmark: drift }, draft, true)).toEqual({
      kind: 'update',
      patch: { id: 7, note: 'Around the duel' },
    });
  });
});

describe('initialBookmarkDraft', () => {
  it('starts empty for a new bookmark, else from the bookmark', () => {
    expect(initialBookmarkDraft()).toEqual({ note: '', label: '' });
    expect(initialBookmarkDraft(bookmark())).toEqual({ note: 'Bridge Four', label: 'favourite' });
  });
});

describe('noteSave', () => {
  it('pins a new note at the place, on every server', () => {
    for (const annotations of [true, false, undefined]) {
      expect(noteSave({ position: 37_200.6 }, ' Theory ', annotations)).toEqual({
        kind: 'add',
        vars: { body: 'Theory', position: 37_201 },
      });
    }
  });

  it('saves nothing empty', () => {
    expect(noteSave({ position: 0 }, '   ', true)).toEqual({ kind: 'empty' });
    expect(noteSave({ position: 0, note: note() }, '', true)).toEqual({ kind: 'empty' });
  });

  it('edits the body only (the note keeps its place), on a server with annotations', () => {
    const request = { position: 37_200, note: note() };
    expect(noteSave(request, 'Track the **Parshendi**', true)).toEqual({ kind: 'unchanged' });
    expect(noteSave(request, 'New theory', true)).toEqual({
      kind: 'update',
      patch: { id: 9, body: 'New theory' },
    });
    expect(noteSave(request, 'New theory', false)).toEqual({ kind: 'unsupported' });
  });
});

describe('edit requests', () => {
  it('open on the row’s own place, a legacy note at 0:00 included', () => {
    expect(editBookmarkRequest(target, bookmark())).toEqual({
      kind: 'bookmark',
      target,
      position: 62_810,
      bookmark: bookmark(),
    });
    expect(editNoteRequest(target, note({ position: 0 }))).toMatchObject({
      kind: 'note',
      position: 0,
    });
  });
});
