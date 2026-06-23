import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { useApi } from '@/api/provider';
import type { Book } from '@/api/types';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { DownloadBadge } from '@/components/library/download-badge';
import { bookSubtitle, formatDuration } from '@/lib/format';
import { useOpen } from '@/lib/open';

/** A book result row (search lists) linking to its detail screen on the given
 * connection. `also` names other servers that also have this (de-duplicated) book. */
export function BookRow({
  book,
  connectionId,
  source,
  also,
}: {
  book: Book;
  connectionId: string;
  /** Where the shown copy lives, e.g. "books.kobol.nexus · Sci-Fi". */
  source?: string;
  also?: { connectionName: string }[];
}) {
  const { t } = useTranslation();
  const api = useApi(connectionId);
  const { openBook } = useOpen();
  const subtitle = bookSubtitle({
    author: book.author,
    series: book.series,
    seriesIndex: book.series_index,
  });
  // Where else this (de-duplicated) copy exists — other servers, else other
  // libraries on this server. Shown on its own line so it isn't truncated.
  const alsoLabel = also?.length
    ? t('library.bookRow.alsoOn', { servers: also.map((a) => a.connectionName).join(', ') })
    : book.other_locations?.length
      ? t('library.bookRow.alsoIn', {
          libraries: book.other_locations.map((l) => l.library_name).join(', '),
        })
      : null;

  return (
    <Pressable
      onPress={() => void openBook(connectionId, book.library_id, book.rel_path)}
      className="flex-row items-center gap-3 rounded-lg bg-white p-2 active:opacity-80 dark:border dark:border-gray-860 dark:bg-gray-840"
    >
      <Cover
        source={{ uri: api.coverUrl(book.library_id, book.rel_path), headers: api.authHeaders() }}
        label={book.title}
        sublabel={book.author}
        rounded="rounded-md"
        size={64}
      />
      <View className="flex-1">
        <Text variant="subtitle" numberOfLines={1}>
          {book.title}
        </Text>
        {subtitle ? (
          <Text variant="muted" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        {source ? (
          <Text variant="caption" numberOfLines={1}>
            {source}
          </Text>
        ) : null}
        {alsoLabel ? (
          <Text variant="caption" numberOfLines={1}>
            {alsoLabel}
          </Text>
        ) : null}
      </View>
      {book.duration ? <Text variant="caption">{formatDuration(book.duration)}</Text> : null}
      <DownloadBadge libraryId={book.library_id} path={book.rel_path} />
      <Icon name="chevron-right" size={14} />
    </Pressable>
  );
}
