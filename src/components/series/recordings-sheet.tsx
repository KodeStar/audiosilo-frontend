import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { RecordingRow } from '@/components/library/recording-row';
import { PlayerSheet } from '@/components/player/player-sheet';
import { useOpen } from '@/lib/open';

import type { SeriesEntry } from './series-model';

/**
 * The recordings of one work on the series shelf (server#241: "2 recordings"), to choose
 * one: each with its cover, narrator, length and the listener's own progress in it, the
 * shelf's shown one included; a press opens that book. A bottom sheet on a phone, a dialog
 * on a desktop (`PlayerSheet`). Mount it at the screen's root: the bottom sheet renders in
 * place. `entry` stays set while it closes, so the list doesn't empty mid-slide.
 */
export function RecordingsSheet({
  entry,
  visible,
  onClose,
  pageLibraryId,
}: {
  entry: SeriesEntry | undefined;
  visible: boolean;
  onClose: () => void;
  /** The series page's library: a recording elsewhere names its own. */
  pageLibraryId: number;
}) {
  const { t } = useTranslation();
  const { openBook } = useOpen();
  return (
    <PlayerSheet
      visible={visible && !!entry?.recordings}
      onClose={onClose}
      title={t('series.recordings.title', { title: entry?.title ?? '' })}
    >
      <View accessibilityRole="list" testID="series-recordings" className="-mx-2">
        {entry?.recordings?.map((r) => (
          <RecordingRow
            key={`${r.copy.libraryId}:${r.copy.path}`}
            connectionId={r.copy.connectionId}
            pageLibraryId={pageLibraryId}
            recording={{
              libraryId: r.copy.libraryId,
              path: r.copy.path,
              book: r.copy.book,
              fraction: r.fraction,
              started: r.started,
              finished: r.finished,
            }}
            onPress={() => {
              onClose();
              void openBook(r.copy.connectionId, r.copy.libraryId, r.copy.path);
            }}
          />
        ))}
      </View>
    </PlayerSheet>
  );
}
