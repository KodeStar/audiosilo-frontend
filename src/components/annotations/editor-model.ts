import { type BookmarkLabel, isBookmarkLabel } from '@/api/bookmark-labels';
import type { AddBookmarkVars } from '@/api/hooks';
import type { Bookmark, BookmarkPatch, Note, NotePatch } from '@/api/types';

/**
 * The bookmark and note editors' rules, pure: what a request opens, the draft it starts
 * from, and what Save sends. The server's bounds (the `annotations` contract): a
 * bookmark's note is at most 2000 characters, a note's body at most 10000.
 */

export const BOOKMARK_NOTE_MAX = 2000;
export const NOTE_BODY_MAX = 10000;

/** The book an annotation belongs to: its own connection, library and path (the same
 * shape as the player's `PlayTarget`). */
export type AnnotationTarget = { connectionId: string; libraryId: number; path: string };

/**
 * What the editor sheet opens on (`usePlayerSheets().openEditor`): a new bookmark or note
 * at `position` (whole-book seconds) of `target`, or an existing one to edit (`bookmark`
 * / `note`, whose own position is `position`). It carries its book, so it works for a
 * book that is not playing, on any connection.
 */
export type EditorRequest =
  | { kind: 'bookmark'; target: AnnotationTarget; position: number; bookmark?: Bookmark }
  | { kind: 'note'; target: AnnotationTarget; position: number; note?: Note };

/** The request to edit a bookmark of `target`. */
export const editBookmarkRequest = (
  target: AnnotationTarget,
  bookmark: Bookmark,
): EditorRequest => ({ kind: 'bookmark', target, position: bookmark.position, bookmark });

/** The request to edit a note of `target`. */
export const editNoteRequest = (target: AnnotationTarget, note: Note): EditorRequest => ({
  kind: 'note',
  target,
  position: note.position,
  note,
});

/** The bookmark editor's fields: the note as typed and the label key (`''` for none). */
export type BookmarkDraft = { note: string; label: string };

/** The draft a bookmark editor starts from: empty for a new one, else the bookmark's own
 * note and label (an unknown label is kept as it is, so an untouched label is never
 * sent back). */
export function initialBookmarkDraft(bookmark?: Bookmark): BookmarkDraft {
  return { note: bookmark?.note ?? '', label: bookmark?.label ?? '' };
}

/** What Save does with a bookmark draft. */
export type BookmarkSave =
  /** Make it (`useAddBookmark`; a label only on a server with `annotations`). */
  | { kind: 'add'; vars: AddBookmarkVars }
  /** Send only what changed (`useUpdateBookmark`). */
  | { kind: 'update'; patch: BookmarkPatch & { id: number } }
  /** An edit that changes nothing: just close. */
  | { kind: 'unchanged' }
  /** An edit on a server without `annotations` (or not known yet): it can't take one. */
  | { kind: 'unsupported' };

/**
 * Save for a bookmark draft. A new bookmark works on every server, with its note; its
 * label goes only to a server known to have `annotations` (an older one rejects the
 * unknown field), never a label this player doesn't offer. An edit needs `annotations`
 * and sends only the fields that changed: the note (trimmed) and the label (`''` clears
 * it).
 */
export function bookmarkSave(
  request: { position: number; bookmark?: Bookmark },
  draft: BookmarkDraft,
  annotations: boolean | undefined,
): BookmarkSave {
  const note = draft.note.trim();
  const { bookmark } = request;
  if (!bookmark) {
    const label = annotations === true && isBookmarkLabel(draft.label) ? draft.label : undefined;
    return {
      kind: 'add',
      vars: { position: Math.round(request.position), note, ...(label ? { label } : {}) },
    };
  }
  if (annotations !== true) return { kind: 'unsupported' };
  const patch: BookmarkPatch & { id: number } = { id: bookmark.id };
  if (note !== bookmark.note.trim()) patch.note = note;
  // The draft's label is the bookmark's own until the picker changes it, and the picker
  // only ever sets a label it offers or clears it.
  if (draft.label !== (bookmark.label ?? '')) patch.label = draft.label as BookmarkLabel | '';
  return patch.note === undefined && patch.label === undefined
    ? { kind: 'unchanged' }
    : { kind: 'update', patch };
}

/** What Save does with a note's body. */
export type NoteSave =
  /** Pin it at the request's position (`useAddNote`). */
  | { kind: 'add'; vars: { body: string; position: number } }
  /** A new body; the note keeps its place (`useUpdateNote`). */
  | { kind: 'update'; patch: NotePatch & { id: number } }
  | { kind: 'unchanged' }
  /** Nothing written: nothing to save (a note can't be empty; Delete removes one). */
  | { kind: 'empty' }
  | { kind: 'unsupported' };

/**
 * Save for a note's body. A new note is pinned at the request's position on every server
 * (the API always took one). An edit needs `annotations` and sends the body only: the
 * note keeps its position.
 */
export function noteSave(
  request: { position: number; note?: Note },
  body: string,
  annotations: boolean | undefined,
): NoteSave {
  const text = body.trim();
  if (!text) return { kind: 'empty' };
  const { note } = request;
  if (!note) {
    return {
      kind: 'add',
      vars: { body: text, position: Math.max(0, Math.round(request.position)) },
    };
  }
  if (annotations !== true) return { kind: 'unsupported' };
  return text === note.body.trim()
    ? { kind: 'unchanged' }
    : { kind: 'update', patch: { id: note.id, body: text } };
}
