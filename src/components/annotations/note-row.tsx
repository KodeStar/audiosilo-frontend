import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useMarkdown } from 'react-native-marked';

import { useCapability } from '@/api/hooks';
import type { Book, Note } from '@/api/types';
import { usePlayerSheets } from '@/components/player/player-sheets';
import { type AnnotationTarget, editNoteRequest } from '@/lib/annotation-request';
import { formatClock, formatRelative } from '@/lib/format';
import { useOpen } from '@/lib/open';
import { bookTitle } from '@/lib/paths';
import { useTheme } from '@/theme/theme-provider';

import { TimeChip } from './chips';
import { AnnotationRowFrame, RowAction, RowCover, RowMeta } from './row-parts';
import { useDeleteWithUndo, useJumpTo } from './use-annotation-actions';

/** A note's markdown body. `useMarkdown` is a hook, so each note renders its own. */
export function NoteMarkdown({ body }: { body: string }) {
  const { scheme } = useTheme();
  const elements = useMarkdown(body, { colorScheme: scheme });
  return (
    <View>
      {elements.map((el, i) => (
        <Fragment key={i}>{el}</Fragment>
      ))}
    </View>
  );
}

export type NoteRowProps = {
  note: Note;
  /** The note's own server (a list across servers passes each row's). */
  connectionId: string;
  /** The chapter at the note's place, when the caller knows the book's chapters. */
  chapter?: string | null;
  /** The book, for a list across books (the Journal): the row leads with its cover. */
  book?: Book;
  /** Overrides the time chip's jump (the companion seeks the playing book in place). */
  onJump?: (position: number) => void;
  /** The list's first row: no hairline above it. */
  first?: boolean;
  /** The server's name, in a list across servers when there is more than one (the
   * Journal passes `useServerFlag`'s); the book's own page and the companion leave it out. */
  server?: string;
};

/**
 * One note (the prototype's Notes tab and Journal): a `community` time chip at the place
 * it is pinned to (a note made before notes had places reads 0:00), the markdown body,
 * the chapter and how long ago, then Edit (where the server takes edits,
 * `annotations`) and Delete (with Undo). Self-contained like `BookmarkRow`.
 */
export function NoteRow({
  note,
  connectionId,
  chapter,
  book,
  onJump,
  first,
  server,
}: NoteRowProps) {
  const { t } = useTranslation();
  const editable = useCapability('annotations', connectionId) === true;
  const jumpTo = useJumpTo();
  const { openBook } = useOpen();
  const target: AnnotationTarget = { connectionId, libraryId: note.library_id, path: note.path };
  const remove = useDeleteWithUndo('note', connectionId, target.libraryId, target.path);
  const time = formatClock(note.position);
  const jump = () => (onJump ? onJump(note.position) : jumpTo(target, note.position));
  const chip = <TimeChip position={note.position} tone="note" onPress={jump} />;
  const title = book ? bookTitle(book.title, book.rel_path) : null;

  return (
    <AnnotationRowFrame
      first={first}
      testID={`note-row-${note.id}`}
      lead={
        book ? (
          <RowCover
            connectionId={connectionId}
            book={book}
            onOpen={() => openBook(connectionId, target.libraryId, target.path, 'notes')}
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
              label={t('annotations.note.edit', { time })}
              onPress={() => usePlayerSheets.getState().openEditor(editNoteRequest(target, note))}
              testID="note-edit"
            />
          ) : null}
          <RowAction
            icon="trash"
            label={t('annotations.note.delete', { time })}
            onPress={() => remove(note)}
            testID="note-delete"
          />
        </>
      }
    >
      {book ? <View className="flex-row">{chip}</View> : null}
      <NoteMarkdown body={note.body} />
      <RowMeta parts={[title, chapter, formatRelative(note.created_at)]} server={server} />
    </AnnotationRowFrame>
  );
}
