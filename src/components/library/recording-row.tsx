import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { Book } from '@/api/types';
import { BookCover } from '@/components/library/book-cover';
import { ProgressBar } from '@/components/ui/progress-bar';
import { InsetRow } from '@/components/ui/row-surface';
import { Text } from '@/components/ui/text';
import { formatDuration } from '@/lib/format';
import { bookTitle } from '@/lib/paths';
import { percentOf, type SavedProgressView } from '@/lib/progress-view';
import { useLibraryName } from '@/stores/library-names';
import { tabularNums } from '@/theme/tabular-nums';

/** One recording of a work (server#241) as a row shows it: the book's facts and the
 * listener's own progress in it. */
export type RecordingFacts = {
  libraryId: number;
  path: string;
  /** Its list row, when loaded (a recording in another library can start without one). */
  book?: Book;
} & SavedProgressView;

/** "Read by Jefferson Mays", else the recording's title: what tells two recordings apart. */
export function recordingLabel(t: TFunction, r: Pick<RecordingFacts, 'book' | 'path'>): string {
  const narrator = r.book?.narrator;
  return narrator ? t('series.readBy', { narrator }) : bookTitle(r.book?.title, r.path);
}

/** "Kids · Abridged · 10h 3m · 40% listened": where it is (`where`, the name of a library
 * other than the page's), what it is, its length and how far the listener is. */
export function recordingCaption(t: TFunction, r: RecordingFacts, where?: string): string {
  const state = r.finished
    ? t('covers.finished')
    : r.started
      ? t('covers.listened', { percent: percentOf(r.fraction) })
      : '';
  return [
    where ?? '',
    r.book?.abridged ? t('book.meta.abridged') : '',
    formatDuration(r.book?.duration),
    state,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * A recording of the work in a list (the book page's "Other recordings in your library",
 * the series shelf's recording picker): its cover, who reads it, its length and the
 * listener's progress in it, and its library when that is not the page's
 * (`pageLibraryId`). A press opens it (`onPress`).
 */
export function RecordingRow({
  connectionId,
  pageLibraryId,
  recording,
  onPress,
}: {
  connectionId: string;
  pageLibraryId: number;
  recording: RecordingFacts;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const { book, libraryId, path } = recording;
  const libraryName = useLibraryName(connectionId, libraryId);
  const label = recordingLabel(t, recording);
  const caption = recordingCaption(
    t,
    recording,
    libraryId === pageLibraryId ? undefined : libraryName,
  );
  const inProgress = recording.started && !recording.finished;
  return (
    <InsetRow onPress={onPress} accessibilityLabel={[label, caption].filter(Boolean).join(', ')}>
      <BookCover
        connectionId={connectionId}
        libraryId={libraryId}
        path={path}
        coverVersion={book?.cover_version}
        width={44}
        title={bookTitle(book?.title, path)}
        author={book?.author}
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="label" numberOfLines={1}>
          {label}
        </Text>
        {caption ? (
          <Text variant="caption" numberOfLines={1} style={tabularNums}>
            {caption}
          </Text>
        ) : null}
        {inProgress ? (
          <ProgressBar fraction={recording.fraction} className="mt-1 max-w-[200px]" />
        ) : null}
      </View>
    </InsetRow>
  );
}
