import { Link } from 'expo-router';
import { Pressable, View } from 'react-native';

import type { FsEntry } from '@/api/types';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { bookSubtitle, formatBitrate, formatDurationFull } from '@/lib/format';
import { bookHref, libraryHref } from '@/lib/paths';
import { colors } from '@/theme/tokens';

/** One row in the filesystem browse view: a folder (pink block, drill in) or an
 * audio file (blue block, opens the book). Ported from the old client's list. */
export function EntryRow({ entry, libraryId }: { entry: FsEntry; libraryId: number }) {
  const isDir = entry.is_dir;
  // Plain folders drill in; book folders and audio leaves open the book screen.
  const href = isDir && !entry.is_book ? libraryHref(libraryId, entry.path) : bookHref(libraryId, entry.path);
  const title = entry.title || entry.name;
  const meta = isDir
    ? bookSubtitle({ author: entry.author, series: entry.series, seriesIndex: entry.series_index })
    : `Duration: ${formatDurationFull(entry.duration)}${
        formatBitrate(entry.size, entry.duration) ? `   Bitrate: ${formatBitrate(entry.size, entry.duration)}` : ''
      }`;

  return (
    <Link href={href} asChild>
      <Pressable className="my-1 w-full flex-row items-center overflow-hidden rounded-lg bg-gray-50 shadow-sm active:opacity-80 dark:border dark:border-gray-900 dark:bg-gray-840 dark:shadow-none">
        <View
          className={`min-h-[3.5rem] items-center justify-center self-stretch px-4 ${isDir ? 'bg-primary' : 'bg-blue-500'}`}
        >
          <Icon name={isDir ? 'folder' : 'book'} size={20} color={colors.white} />
        </View>
        <View className="flex-1 px-5 py-2">
          <Text variant="subtitle" numberOfLines={1}>
            {title}
          </Text>
          {meta ? (
            <Text variant="caption" numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
        <Icon name="chevron-right" size={16} className="mr-4" />
      </Pressable>
    </Link>
  );
}
