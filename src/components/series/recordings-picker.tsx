import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';

import { RecordingRow } from '@/components/library/recording-row';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FilterChip } from '@/components/ui/filter-chip';
import { useOpen } from '@/lib/open';

import type { SeriesEntry, SeriesRecording } from './series-model';
import { usePlacedBooks } from './use-series-data';

/**
 * "2 recordings", for a work the listener holds in more than one (server#241, the model's
 * `recordings`): a picker chip opening a dialog (a sheet on a phone) of every recording,
 * the shelf's shown one included, each with its cover, narrator, length and the listener's
 * own progress in it; a press opens that book. Nothing for a single recording. A recording
 * whose row the page did not read (one the listener never played) is read when the picker
 * opens (fe#313).
 */
export function RecordingsChip({
  entry,
  pageLibraryId,
}: {
  entry: SeriesEntry;
  /** The series page's library: a recording elsewhere names its own. */
  pageLibraryId: number;
}) {
  const { t } = useTranslation();
  const { openBook } = useOpen();
  const [open, setOpen] = useState(false);
  const recordings = entry.recordings;
  if (!recordings) return null;
  const label = t('series.recordings.count', { count: recordings.length });
  const title = entry.title ?? '';
  return (
    <>
      <FilterChip
        label={label}
        selected={false}
        picker
        icon="microphone"
        onPress={() => setOpen(true)}
        accessibilityLabel={`${label}, ${t('series.recordings.choose', { title })}`}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader className="pr-10">
            <DialogTitle>{t('series.recordings.title', { title })}</DialogTitle>
          </DialogHeader>
          <ScrollView
            className="-mx-2 max-h-[420px]"
            accessibilityRole="list"
            testID="series-recordings"
          >
            {open ? (
              <RecordingRows
                recordings={recordings}
                pageLibraryId={pageLibraryId}
                onOpen={(r) => {
                  setOpen(false);
                  void openBook(r.copy.connectionId, r.copy.libraryId, r.copy.path);
                }}
              />
            ) : null}
          </ScrollView>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The dialog's rows, mounted only while it is open: a recording whose row the page did not
 * read is read here. */
function RecordingRows({
  recordings,
  pageLibraryId,
  onOpen,
}: {
  recordings: readonly SeriesRecording[];
  pageLibraryId: number;
  onOpen: (r: SeriesRecording) => void;
}) {
  const unread = recordings.filter((r) => !r.copy.book);
  const read = usePlacedBooks(
    recordings[0]?.copy.connectionId ?? '',
    unread.map((r) => ({ library_id: r.copy.libraryId, path: r.copy.path })),
  );
  return recordings.map((r) => (
    <RecordingRow
      key={`${r.copy.libraryId}:${r.copy.path}`}
      connectionId={r.copy.connectionId}
      pageLibraryId={pageLibraryId}
      recording={{
        ...r.copy,
        ...r,
        book:
          r.copy.book ??
          read.find((b) => b.library_id === r.copy.libraryId && b.rel_path === r.copy.path),
      }}
      onPress={() => onOpen(r)}
    />
  ));
}
