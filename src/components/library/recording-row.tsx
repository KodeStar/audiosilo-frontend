import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import type { Book } from '@/api/types';
import { BookCover } from '@/components/library/book-cover';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { ProgressBar } from '@/components/ui/progress-bar';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { formatDuration } from '@/lib/format';
import { bookTitle } from '@/lib/paths';
import { percentOf } from '@/lib/progress-view';
import { cn } from '@/lib/utils';
import { useLibraryName } from '@/stores/library-names';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

/** One recording of a work (server#241) as a row shows it: the book's facts and the
 * listener's own progress in it. */
export type RecordingFacts = {
  libraryId: number;
  path: string;
  /** Its list row, when loaded (a recording in another library can start without one). */
  book?: Book;
  fraction: number;
  started: boolean;
  finished: boolean;
};

/** "Read by Jefferson Mays", else the recording's title: what tells two recordings apart. */
export function recordingLabel(t: TFunction, r: Pick<RecordingFacts, 'book' | 'path'>): string {
  const narrator = r.book?.narrator;
  return narrator ? t('series.readBy', { narrator }) : bookTitle(r.book?.title ?? '', r.path);
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
  const themed = useThemeColors();
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
    // A list item around each button (a list holds items).
    <View role="listitem">
      <AnimatedPressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={[label, caption].filter(Boolean).join(', ')}
        className={cn(
          'min-h-[48px] flex-row items-center gap-3 rounded-control px-2 py-2 active:bg-accent',
          Platform.select({ web: `cursor-pointer hover:bg-accent ${FOCUS_RING_CLASS}` }),
        )}
      >
        <BookCover
          connectionId={connectionId}
          libraryId={libraryId}
          path={path}
          coverVersion={book?.cover_version}
          width={44}
          title={bookTitle(book?.title ?? '', path)}
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
        <Icon name="chevron-right" size={14} color={themed.mutedForeground} />
      </AnimatedPressable>
    </View>
  );
}
