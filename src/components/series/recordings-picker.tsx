import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';

import { RecordingRow } from '@/components/library/recording-row';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FilterChip } from '@/components/ui/filter-chip';
import { useOpen } from '@/lib/open';

import type { SeriesEntry } from './series-model';

/**
 * "2 recordings", for a work the listener holds in more than one (server#241, the model's
 * `recordings`): a picker chip opening a dialog (a sheet on a phone) of every recording,
 * the shelf's shown one included, each with its cover, narrator, length and the listener's
 * own progress in it; a press opens that book. Nothing for a single recording.
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
  return (
    <>
      <FilterChip
        label={label}
        selected={false}
        picker
        icon="microphone"
        onPress={() => setOpen(true)}
        accessibilityLabel={`${label}, ${t('series.recordings.choose', { title: entry.title })}`}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader className="pr-10">
            <DialogTitle>{t('series.recordings.title', { title: entry.title ?? '' })}</DialogTitle>
          </DialogHeader>
          <ScrollView
            className="-mx-2 max-h-[420px]"
            accessibilityRole="list"
            testID="series-recordings"
          >
            {recordings.map((r) => (
              <RecordingRow
                key={`${r.copy.libraryId}:${r.copy.path}`}
                connectionId={r.copy.connectionId}
                pageLibraryId={pageLibraryId}
                recording={{ ...r.copy, ...r }}
                onPress={() => {
                  setOpen(false);
                  void openBook(r.copy.connectionId, r.copy.libraryId, r.copy.path);
                }}
              />
            ))}
          </ScrollView>
        </DialogContent>
      </Dialog>
    </>
  );
}
