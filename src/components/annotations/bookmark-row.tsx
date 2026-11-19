import { useTranslation } from 'react-i18next';

import type { Bookmark } from '@/api/types';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { formatClock } from '@/lib/format';
import {
  discardQueuedBookmark,
  requeueBookmark,
  type QueuedBookmark,
} from '@/playback/annotation-outbox';

import { AnnotationRow, type AnnotationRowProps } from './annotation-row';
import { LabelChip, TimeChip } from './chips';
import { isDriftBookmark, shownNote } from './drift-marker';
import { AnnotationRowFrame, RowAction, RowMeta } from './row-parts';
import { BOOKMARK_DELETE_COPY, deletedToast, useJumpTo } from './use-annotation-actions';

type BookmarkRowProps = AnnotationRowProps & { bookmark: Bookmark };

/**
 * One bookmark (`AnnotationRow`): the label as a kicker, the note (a Quote as a
 * quotation; the sleep timer's "Fell asleep" marker with a moon, reading as where the
 * listener drifted off), then the shared chip, meta line and actions.
 */
export function BookmarkRow({ bookmark, ...props }: BookmarkRowProps) {
  const drift = isDriftBookmark(bookmark);
  return (
    <AnnotationRow
      kind="bookmark"
      row={bookmark}
      kicker={<LabelChip label={bookmark.label} drift={drift} />}
      {...props}
    >
      <BookmarkNote label={bookmark.label} note={shownNote(bookmark)} drift={drift} />
    </AnnotationRow>
  );
}

/**
 * A bookmark still waiting on this device for its server (the bookmark outbox, fe#356): the
 * same chip, label and note as a bookmark row, "Waiting to sync" in its meta line, and
 * Delete, which takes it out of the outbox unsent (with Undo). No Edit: the server has not
 * given it an id yet.
 */
export function QueuedBookmarkRow({
  bookmark,
  chapter,
  onJump,
  first,
}: Pick<AnnotationRowProps, 'chapter' | 'onJump' | 'first'> & { bookmark: QueuedBookmark }) {
  const { t } = useTranslation();
  const jumpTo = useJumpTo();
  const { connectionId, libraryId, path, position, note, label } = bookmark;
  const drift = isDriftBookmark({ label, note });
  const time = formatClock(position);
  const jump = () =>
    onJump ? onJump(position) : jumpTo({ connectionId, libraryId, path }, position);
  const remove = () =>
    void discardQueuedBookmark(bookmark.id).then(
      (removed) => {
        if (!removed) return; // sent meanwhile: the list shows it as made
        // Undo puts it back in the outbox, not on the server: a replay may have sent it
        // just before the Delete. It keeps its `client_id` (and what a send without it did),
        // so its replay finds it there rather than making it twice.
        deletedToast(t, BOOKMARK_DELETE_COPY, position, () => requeueBookmark(removed));
      },
      () => toast({ title: t(BOOKMARK_DELETE_COPY.deleteFailed) }),
    );
  return (
    <AnnotationRowFrame
      first={first}
      testID={`bookmark-queued-${bookmark.id}`}
      lead={<TimeChip position={position} tone="bookmark" onPress={jump} />}
      actions={
        <RowAction
          icon="trash"
          label={t('annotations.bookmark.delete', { time })}
          onPress={remove}
          testID="bookmark-queued-delete"
        />
      }
    >
      <LabelChip label={label} drift={drift} />
      <BookmarkNote label={label} note={shownNote({ label, note })} drift={drift} />
      <RowMeta parts={[chapter, t('annotations.bookmark.waiting')]} />
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
