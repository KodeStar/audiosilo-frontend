import type { ParseKeys } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useCapability } from '@/api/hooks';
import type { Book } from '@/api/types';
import { usePlayerSheets } from '@/components/player/player-sheets';
import {
  type AnnotationKind,
  type AnnotationOf,
  type AnnotationTarget,
  editBookmarkRequest,
  type EditorRequest,
  editNoteRequest,
} from '@/lib/annotation-request';
import { formatClock, formatRelative } from '@/lib/format';
import { useOpen } from '@/lib/open';
import { bookTitle, type BookTab } from '@/lib/paths';

import { TimeChip, type TimeChipTone } from './chips';
import { AnnotationRowFrame, RowAction, RowCover, RowMeta } from './row-parts';
import { useDeleteWithUndo, useJumpTo } from './use-annotation-actions';

/** What tells a bookmark row from a note row: the chip's tone, the actions' names, the
 * book page tab a row across books opens, and the request its Edit opens. */
const ROW_KIND: {
  [K in AnnotationKind]: {
    tone: TimeChipTone;
    copy: { edit: ParseKeys; delete: ParseKeys };
    tab: BookTab;
    editRequest: (target: AnnotationTarget, row: AnnotationOf[K]) => EditorRequest;
  };
} = {
  bookmark: {
    tone: 'bookmark',
    copy: { edit: 'annotations.bookmark.edit', delete: 'annotations.bookmark.delete' },
    tab: 'bookmarks',
    editRequest: editBookmarkRequest,
  },
  note: {
    tone: 'note',
    copy: { edit: 'annotations.note.edit', delete: 'annotations.note.delete' },
    tab: 'notes',
    editRequest: editNoteRequest,
  },
};

/** What a bookmark or note row takes besides the row itself. */
export type AnnotationRowProps = {
  /** The row's own server (a list across servers passes each row's). */
  connectionId: string;
  /** The chapter at the row's place, when the caller knows the book's chapters
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
 * One bookmark or note (STYLEGUIDE section 8, "Bookmark"; the prototype's book page tabs
 * and Journal): the time chip that jumps there (or the book's cover across books, the
 * chip then heading the body beside `kicker`), the body, the chapter and how long ago,
 * then Edit (only where the server takes edits, `annotations`) and Delete (with Undo).
 * Self-contained: it acts on its own book through `connectionId`, so it works for any
 * book, the screen's or not.
 */
export function AnnotationRow<K extends AnnotationKind>({
  kind,
  row,
  kicker,
  children,
  connectionId,
  chapter,
  book,
  onJump,
  first,
  server,
}: AnnotationRowProps & {
  kind: K;
  row: AnnotationOf[K];
  /** Beside the chip at the top of the body (a bookmark's label). */
  kicker?: ReactNode;
  /** The body (a bookmark's note, a note's markdown). */
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { tone, copy, tab, editRequest } = ROW_KIND[kind];
  const editable = useCapability('annotations', connectionId) === true;
  const jumpTo = useJumpTo();
  const { openBook } = useOpen();
  const target: AnnotationTarget = { connectionId, libraryId: row.library_id, path: row.path };
  const remove = useDeleteWithUndo(kind, connectionId, target.libraryId, target.path);
  const time = formatClock(row.position);
  const jump = () => (onJump ? onJump(row.position) : jumpTo(target, row.position));
  const chip = <TimeChip position={row.position} tone={tone} onPress={jump} />;
  const title = book ? bookTitle(book.title, book.rel_path) : null;

  return (
    <AnnotationRowFrame
      first={first}
      testID={`${kind}-row-${row.id}`}
      lead={
        book ? (
          <RowCover
            connectionId={connectionId}
            book={book}
            onOpen={() => openBook(connectionId, target.libraryId, target.path, tab)}
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
              label={t(copy.edit, { time })}
              onPress={() => usePlayerSheets.getState().openEditor(editRequest(target, row))}
              testID={`${kind}-edit`}
            />
          ) : null}
          <RowAction
            icon="trash"
            label={t(copy.delete, { time })}
            onPress={() => remove(row)}
            testID={`${kind}-delete`}
          />
        </>
      }
    >
      {book ? (
        <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
          {chip}
          {kicker}
        </View>
      ) : (
        kicker
      )}
      {children}
      <RowMeta parts={[title, chapter, formatRelative(row.created_at)]} server={server} />
    </AnnotationRowFrame>
  );
}
