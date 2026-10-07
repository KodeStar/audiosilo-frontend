import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useCapability } from '@/api/hooks';
import type { Book, Bookmark } from '@/api/types';
import { usePlayerSheets } from '@/components/player/player-sheets';
import { Text } from '@/components/ui/text';
import { formatClock, formatRelative } from '@/lib/format';
import { useOpen } from '@/lib/open';
import { bookTitle } from '@/lib/paths';

import { LabelChip, TimeChip } from './chips';
import { isDriftBookmark, shownNote } from './drift-marker';
import { type AnnotationTarget, editBookmarkRequest } from './editor-model';
import { AnnotationRowFrame, RowAction, RowCover, RowMeta } from './row-parts';
import { useDeleteWithUndo, useJumpTo } from './use-annotation-actions';

export type BookmarkRowProps = {
  bookmark: Bookmark;
  /** The bookmark's own server (a list across servers passes each row's). */
  connectionId: string;
  /** The chapter at the bookmark, when the caller knows the book's chapters
   * (`useChapterNamer`). */
  chapter?: string | null;
  /** The book, for a list across books (the Journal): the row leads with its cover
   * (opening its page) and names it. Leave it out where the screen is the book's own. */
  book?: Book;
  /** Overrides the time chip's jump (the companion seeks the playing book in place);
   * by default it goes through `useJumpTo`. */
  onJump?: (position: number) => void;
  /** The list's first row: no hairline above it. */
  first?: boolean;
  /** The server's name, in a list across servers when there is more than one (the
   * Journal passes `useServerFlag`'s); the book's own page and the companion leave it out. */
  server?: string;
};

/**
 * One bookmark (STYLEGUIDE section 8, "Bookmark"; the prototype's Bookmarks tab and
 * Journal): the time chip that jumps there, the label, the note (a Quote as a quotation;
 * the sleep timer's "Fell asleep" marker with a moon, reading as where the listener
 * drifted off), the chapter and how long ago, then Edit (only where the server takes
 * edits, `annotations`) and Delete (with Undo). Self-contained: it acts on its own book
 * through `connectionId`, so it works for any book, the screen's or not.
 */
export function BookmarkRow({
  bookmark,
  connectionId,
  chapter,
  book,
  onJump,
  first,
  server,
}: BookmarkRowProps) {
  const { t } = useTranslation();
  const editable = useCapability('annotations', connectionId) === true;
  const jumpTo = useJumpTo();
  const { openBook } = useOpen();
  const target: AnnotationTarget = {
    connectionId,
    libraryId: bookmark.library_id,
    path: bookmark.path,
  };
  const remove = useDeleteWithUndo('bookmark', connectionId, target.libraryId, target.path);
  const time = formatClock(bookmark.position);
  const drift = isDriftBookmark(bookmark);
  const note = shownNote(bookmark);
  const jump = () => (onJump ? onJump(bookmark.position) : jumpTo(target, bookmark.position));
  const chip = <TimeChip position={bookmark.position} onPress={jump} />;
  const title = book ? bookTitle(book.title, book.rel_path) : null;

  return (
    <AnnotationRowFrame
      first={first}
      testID={`bookmark-row-${bookmark.id}`}
      lead={
        book ? (
          <RowCover
            connectionId={connectionId}
            book={book}
            onOpen={() => openBook(connectionId, target.libraryId, target.path, 'bookmarks')}
          />
        ) : (
          chip
        )
      }
      actions={
        <>
          {editable ? (
            <RowAction
              icon="pen"
              label={t('annotations.bookmark.edit', { time })}
              onPress={() =>
                usePlayerSheets.getState().openEditor(editBookmarkRequest(target, bookmark))
              }
              testID="bookmark-edit"
            />
          ) : null}
          <RowAction
            icon="trash"
            label={t('annotations.bookmark.delete', { time })}
            onPress={() => remove(bookmark)}
            testID="bookmark-delete"
          />
        </>
      }
    >
      {book ? (
        <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
          {chip}
          <LabelChip label={bookmark.label} drift={drift} />
        </View>
      ) : (
        <LabelChip label={bookmark.label} drift={drift} />
      )}
      <BookmarkNote label={bookmark.label} note={note} drift={drift} />
      <RowMeta parts={[title, chapter, formatRelative(bookmark.created_at)]} server={server} />
    </AnnotationRowFrame>
  );
}

/** A bookmark's note: a Quote as a quotation, a drift marker as where the listener
 * drifted off, no note said quietly. */
function BookmarkNote({ label, note, drift }: { label?: string; note: string; drift: boolean }) {
  const { t } = useTranslation();
  if (!note) {
    return (
      <Text variant="muted" className={drift ? undefined : 'text-subtle-foreground'}>
        {drift ? t('annotations.drift.marker') : t('annotations.bookmark.noNote')}
      </Text>
    );
  }
  if (label === 'quote') {
    // Fraunces is not loaded (the guide's quote face): the quotation marks and italics
    // carry it in the body face.
    return (
      <Text variant="body" className="italic" testID="bookmark-quote">
        {t('annotations.quoted', { text: note })}
      </Text>
    );
  }
  return <Text variant="body">{note}</Text>;
}
