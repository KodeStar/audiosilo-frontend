import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { Book, ChaptersResponse } from '@/api/types';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { codecLabel } from '@/playback/transcode';
import { useNeedsWebTranscode } from '@/playback/transcode-capability';
import { useThemeColors } from '@/theme/use-theme-colors';

/**
 * One muted line under the book page's actions when this browser will play the book through the
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
  const themed = useThemeColors();
  const transcoded = useNeedsWebTranscode(book, chapterData, connectionId);
  if (downloaded || !transcoded) return null;
  const codec = codecLabel(chapterData?.codec || book.codec);
  return (
    <View className="flex-row items-center gap-1.5">
      <Icon name="rotate" size={13} color={themed.mutedForeground} />
      <Text variant="caption" className="shrink">
        {codec ? t('book.transcodeNote', { codec }) : t('book.transcodeNoteGeneric')}
      </Text>
    </View>
  );
}
