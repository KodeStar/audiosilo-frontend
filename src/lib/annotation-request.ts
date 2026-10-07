import type { Bookmark, Note } from '@/api/types';

/**
 * What the bookmark and note editors open on, in a module of its own so the player's
 * sheet store (`usePlayerSheets`) and the annotations components can both use it
 * without importing each other.
 */

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
