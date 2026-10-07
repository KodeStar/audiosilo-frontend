import { useTranslation } from 'react-i18next';

import type { Bookmark } from '@/api/types';
import { Text } from '@/components/ui/text';

import { AnnotationRow, type AnnotationRowProps } from './annotation-row';
import { LabelChip } from './chips';
import { isDriftBookmark, shownNote } from './drift-marker';

export type BookmarkRowProps = AnnotationRowProps & { bookmark: Bookmark };

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
