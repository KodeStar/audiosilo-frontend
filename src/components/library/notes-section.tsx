import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useCapability, useNotes } from '@/api/hooks';
import { useCid } from '@/api/provider';
import {
  AddNoteAction,
  type AnnotationTarget,
  JournalLink,
  NoteRow,
  useChapterNamer,
} from '@/components/annotations';
import { EmptyState } from '@/components/ui/empty-state';
import { RowSkeletonList } from '@/components/ui/skeleton';
import { byPosition } from '@/lib/by-position';

/**
 * A book's notes (the book page's Notes tab, the player companion's): "Note at 17:26:50"
 * (the note editor, pinned to the listener's place in the book) and "See all in your
 * journal" on top, then one `NoteRow` per note in book order (jump, markdown body,
 * chapter, age, edit, delete with Undo), with loading, error and empty states.
 */
export function NotesSection({
  libraryId,
  path,
  connectionId,
  onJump,
}: {
  libraryId: number;
  path: string;
  /** Source connection; defaults to the active one. The player passes the playing
   * book's connection so notes address the right server. */
  connectionId?: string;
  /** Where a tap on a note's time goes (see `BookmarksSection`'s `onJump`). */
  onJump?: (position: number) => void;
}) {
  const { t } = useTranslation();
  const cid = useCid(connectionId);
  const target: AnnotationTarget = useMemo(
    () => ({ connectionId: cid, libraryId, path }),
    [cid, libraryId, path],
  );
  const query = useNotes(libraryId, path, connectionId);
  const annotations = useCapability('annotations', cid);
  const chapterAt = useChapterNamer(target);
  const notes = useMemo(() => byPosition(query.data ?? []), [query.data]);

  return (
    <View>
      <View className="flex-row flex-wrap items-center justify-between gap-2 pb-2">
        <AddNoteAction target={target} />
        {annotations === true ? <JournalLink tab="notes" /> : null}
      </View>
      {query.isPending ? (
        <RowSkeletonList count={2} />
      ) : query.isError ? (
        <EmptyState
          icon="circle-exclamation"
          title={t('annotations.note.loadFailed')}
          action={{ label: t('common.retry'), onPress: () => void query.refetch() }}
          className="py-6"
        />
      ) : notes.length === 0 ? (
        <EmptyState
          icon="notes"
          title={t('annotations.note.empty')}
          hint={t('annotations.note.emptyHint')}
          className="py-6"
        />
      ) : (
        notes.map((note, i) => (
          <NoteRow
            key={note.id}
            note={note}
            connectionId={cid}
            chapter={chapterAt(note.position)}
            onJump={onJump}
            first={i === 0}
          />
        ))
      )}
    </View>
  );
}
