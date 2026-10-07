import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { Book, ChaptersResponse } from '@/api/types';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { codecLabel } from '@/playback/transcode';
import { useThemeColors } from '@/theme/use-theme-colors';

/**
 * One muted line under the book page's actions when this browser will play the book through the
 * server's transcoder ("AC-3 audio is converted to MP3 for this browser"): web only,
 * under exactly the rule playback uses (`needsWebTranscode`, which the page reads once
 * and passes as `transcoded`), and never for a book
 * that plays from a download (local files are never converted). Renders nothing
 * otherwise, so native and every ordinary book are untouched.
 */
export function TranscodeNote({
  book,
  chapterData,
  transcoded,
  downloaded,
}: {
  book: Book;
  chapterData?: ChaptersResponse;
  /** This browser plays the book through the server's transcoder (the page's
   * `useNeedsWebTranscode`). */
  transcoded: boolean;
  downloaded: boolean;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
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
