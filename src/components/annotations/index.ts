/**
 * Bookmarks and notes (player redesign Phase 4): the rows, chips, editors and rules the
 * book page, the player's companion and the Journal share. Pure modules (`labels`,
 * `drift-marker`, `editor-model`, `order`) have no React; the rest are components and
 * hooks.
 */
export { AnnotationEditor, AnnotationEditorSheet } from './annotation-editor';
export { BookmarkRow, type BookmarkRowProps } from './bookmark-row';
export { LabelChip, LabelPicker, TimeChip, type TimeChipTone } from './chips';
export { isDriftBookmark, isFellAsleepNote, shownNote } from './drift-marker';
export {
  BOOKMARK_NOTE_MAX,
  type BookmarkDraft,
  type BookmarkSave,
  bookmarkSave,
  initialBookmarkDraft,
  NOTE_BODY_MAX,
  type NoteSave,
  noteSave,
} from './editor-model';
export { labelText, toggleLabel } from './labels';
export {
  type AnnotationTarget,
  editBookmarkRequest,
  editNoteRequest,
  type EditorRequest,
} from '@/lib/annotation-request';
export { NoteMarkdown, NoteRow, type NoteRowProps } from './note-row';
export { AddBookmarkAction, AddNoteAction, JournalLink } from './section-actions';
export {
  restoreBookmark,
  restoreNote,
  useDeleteWithUndo,
  useJumpTo,
} from './use-annotation-actions';
export { chapterNamer, useChapterNamer, usePlaceIn } from './use-book-place';
