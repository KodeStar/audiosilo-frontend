/**
 * Bookmarks and notes (player redesign Phase 4): what the book page, the player's
 * companion and the Journal use of them. Inside, pure modules (`labels`, `drift-marker`,
 * `editor-model`) hold the rules, the rest are components and hooks; the player's sheet
 * host imports the editor sheet from `./annotation-editor` itself, and the editor's
 * request lives in `@/lib/annotation-request`.
 */
export { AnnotationSection, type AnnotationSectionProps } from './annotation-section';
export { BookmarkRow } from './bookmark-row';
export { isDriftBookmark } from './drift-marker';
export { labelText } from './labels';
export { NoteRow } from './note-row';
export { RowCover, ServerFlag } from './row-parts';
export { useJumpTo } from './use-annotation-actions';
export { chapterNamer, useChapterNamer } from './use-book-place';
