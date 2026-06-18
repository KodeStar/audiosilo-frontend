import { Link } from 'expo-router';
import { Pressable, View } from 'react-native';

import { useApi } from '@/api/provider';
import type { Book } from '@/api/types';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { DownloadBadge } from '@/components/library/download-badge';
import { bookSubtitle, formatDuration } from '@/lib/format';
import { bookHref } from '@/lib/paths';

/** A book result row (search / indexed lists) linking to its detail screen. */
export function BookRow({ book }: { book: Book }) {
  const api = useApi();
  const subtitle = bookSubtitle({
    author: book.author,
    series: book.series,
    seriesIndex: book.series_index,
  });

  return (
    <Link href={bookHref(book.library_id, book.rel_path)} asChild>
      <Pressable className="flex-row items-center gap-3 rounded-lg bg-white p-2 active:opacity-80 dark:border dark:border-gray-860 dark:bg-gray-840">
        <Cover
          source={{ uri: api.coverUrl(book.library_id, book.rel_path), headers: api.authHeaders() }}
          label={book.title}
          rounded="rounded-md"
          size={48}
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
        </View>
        {book.duration ? <Text variant="caption">{formatDuration(book.duration)}</Text> : null}
        <DownloadBadge libraryId={book.library_id} path={book.rel_path} />
        <Icon name="chevron-right" size={14} />
      </Pressable>
    </Link>
  );
}
