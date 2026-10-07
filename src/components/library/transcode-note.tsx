import { useTranslation } from 'react-i18next';

import type { Book, ChaptersResponse } from '@/api/types';
import { Text } from '@/components/ui/text';
import { codecLabel } from '@/playback/transcode';
import { useNeedsWebTranscode } from '@/playback/transcode-capability';

/**
 * One muted line on the book page when this browser will play the book through the
 * server's transcoder ("AC-3 audio is converted to MP3 for this browser"): web only,
 * under exactly the rule playback uses (`needsWebTranscode`), and never for a book
 * that plays from a download (local files are never converted). Renders nothing
 * otherwise, so native and every ordinary book are untouched.
 */
export function TranscodeNote({
  book,
  chapterData,
  connectionId,
  downloaded,
}: {
  book: Book;
  chapterData?: ChaptersResponse;
  /** The book's connection (its server's `transcode` flag). */
  connectionId: string;
  downloaded: boolean;
}) {
  const { t } = useTranslation();
  const transcoded = useNeedsWebTranscode(book, chapterData, connectionId);
  if (downloaded || !transcoded) return null;
  const codec = codecLabel(chapterData?.codec || book.codec);
  return (
    <Text variant="caption" className="text-center">
      {codec ? t('book.transcodeNote', { codec }) : t('book.transcodeNoteGeneric')}
    </Text>
  );
}
