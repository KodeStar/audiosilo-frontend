import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useSavedProgress } from '@/api/hooks';
import type { Book } from '@/api/types';
import { RecordingRow } from '@/components/library/recording-row';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { useOpen } from '@/lib/open';
import { savedProgressView } from '@/lib/progress-view';

/**
 * The book page's "Other recordings in your library" card (server#241): the listener's
 * other recordings of this book's work (another narrator, an abridged one), as the server's
 * `/item` lists them (`other_recordings`), each with its cover, narrator, length and the
 * listener's own progress in it, opening that book. Nothing when the server sends none (an
 * older one, community metadata off, a work held once).
 */
export function OtherRecordings({ book, connectionId }: { book: Book; connectionId: string }) {
  const { t } = useTranslation();
  const others = book.other_recordings;
  if (!others?.length) return null;
  return (
    <Card testID="book-other-recordings" className="gap-2.5">
      <Text variant="eyebrow">{t('book.otherRecordings.title')}</Text>
      <View accessibilityRole="list" className="-mx-2">
        {others.map((other) => (
          <OtherRecording
            key={`${other.library_id}:${other.rel_path}`}
            other={other}
            connectionId={connectionId}
            pageLibraryId={book.library_id}
          />
        ))}
      </View>
    </Card>
  );
}

function OtherRecording({
  other,
  connectionId,
  pageLibraryId,
}: {
  other: Book;
  connectionId: string;
  pageLibraryId: number;
}) {
  const { openBook } = useOpen();
  const saved = useSavedProgress(other.library_id, other.rel_path, connectionId);
  return (
    <RecordingRow
      connectionId={connectionId}
      pageLibraryId={pageLibraryId}
      recording={{
        libraryId: other.library_id,
        path: other.rel_path,
        book: other,
        ...savedProgressView(saved, other.duration),
      }}
      onPress={() => void openBook(connectionId, other.library_id, other.rel_path)}
    />
  );
}
