import { Link } from 'expo-router';
import { Pressable, View } from 'react-native';

import { useApi } from '@/api/provider';
import type { FsEntry } from '@/api/types';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { bookSubtitle, formatDuration } from '@/lib/format';
import { bookHref, libraryHref } from '@/lib/paths';
import { colors } from '@/theme/tokens';

/** One row in the filesystem browse view: a folder (drill in) or a book. */
export function EntryRow({ entry, libraryId }: { entry: FsEntry; libraryId: number }) {
  const api = useApi();
  const isBook = Boolean(entry.is_book) || (entry.is_audio && !entry.is_dir);
  const isFolder = entry.is_dir && !entry.is_book;
  const href = isFolder ? libraryHref(libraryId, entry.path) : bookHref(libraryId, entry.path);
  const title = entry.title || entry.name;
  const subtitle = bookSubtitle({
    author: entry.author,
    series: entry.series,
    seriesIndex: entry.series_index,
  });

  return (
    <Link href={href} asChild>
      <Pressable className="flex-row items-center gap-3 rounded-lg bg-white p-2 active:opacity-80 dark:border dark:border-gray-860 dark:bg-gray-840">
        {isFolder ? (
          <View className="h-12 w-12 items-center justify-center rounded-md bg-gray-100 dark:bg-gray-860">
            <Icon name="folder" size={22} color={colors.primary} />
          </View>
        ) : (
          <Cover
            source={{ uri: api.coverUrl(libraryId, entry.path), headers: api.authHeaders() }}
            label={title}
            rounded="rounded-md"
            size={48}
          />
        )}
        <View className="flex-1">
          <Text variant="subtitle" numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text variant="muted" numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {entry.duration ? <Text variant="caption">{formatDuration(entry.duration)}</Text> : null}
        <Icon name="chevron-right" size={14} />
      </Pressable>
    </Link>
  );
}
