import { Link } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useFavourites, useToggleFavourite } from '@/api/hooks';
import type { FsEntry } from '@/api/types';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatBitrate, formatDurationFull } from '@/lib/format';
import { bookHref, libraryHref } from '@/lib/paths';
import { colors } from '@/theme/tokens';

// A quiet surface row: soft shadow in light, hairline border in dark. The loud
// filled folder/book blocks are demoted to a tinted glyph tile - folders keep a
// pink identity (primary/10), books/files a harmonized low-alpha blue tint.
const ROW_SURFACE =
  'rounded-xl bg-white shadow-sm dark:border dark:border-gray-750 dark:bg-gray-840 dark:shadow-none';

/** One row in the filesystem browse view: a folder (pink glyph tile, drill in) or
 * an audio file (blue glyph tile, opens the book). `connectionId` is the browse
 * scope's server, so drilling in / opening a book stays on the same connection. */
export function EntryRow({
  entry,
  connectionId,
  libraryId,
}: {
  entry: FsEntry;
  connectionId: string;
  libraryId: number;
}) {
  const { t } = useTranslation();
  const isDir = entry.is_dir;
  const { data: favourites } = useFavourites();
  const toggleFavourite = useToggleFavourite();
  const isFavourite = !!favourites?.some(
    (f) => f.library_id === libraryId && f.path === entry.path,
  );
  // Plain folders drill in; book folders and audio leaves open the book screen.
  const href =
    isDir && !entry.is_book
      ? libraryHref(connectionId, libraryId, entry.path)
      : bookHref(connectionId, libraryId, entry.path);
  // Show what's on disk - the name the user gave the folder/file - as the title,
  // so sibling parts ("CD 1", "CD 2", …) stay distinct. The grabbed book metadata
  // (title, author) goes underneath when it adds something the name doesn't.
  const title = entry.name;
  const bitrate = formatBitrate(entry.size, entry.duration);
  const meta = isDir
    ? [entry.is_book && entry.title && entry.title !== entry.name ? entry.title : '', entry.author]
        .filter(Boolean)
        .join(' · ')
    : `${t('library.entryRow.duration', { value: formatDurationFull(entry.duration) })}${
        bitrate ? `   ${t('library.entryRow.bitrate', { value: bitrate })}` : ''
      }`;

  // The heart must NOT be inside the Link: a nested press bubbles to the Link's
  // anchor on web and navigates into the row. So the navigable area (icon + text
  // + chevron) and the heart are siblings within the row.
  return (
    <View className="my-1 w-full flex-row items-center gap-2">
      <Link href={href} asChild>
        <AnimatedPressable
          accessibilityRole="link"
          className={`flex-1 flex-row items-center gap-3 px-3 py-2 ${ROW_SURFACE}`}
        >
          <View
            className={`h-10 w-10 items-center justify-center rounded-lg ${isDir ? 'bg-primary/10' : 'bg-blue-500/10 dark:bg-blue-500/15'}`}
          >
            <Icon
              name={isDir ? 'folder' : 'book'}
              size={18}
              color={isDir ? colors.primary : colors.blue}
            />
          </View>
          <View className="flex-1">
            <Text variant="subtitle" numberOfLines={1}>
              {title}
            </Text>
            {meta ? (
              <Text variant="caption" numberOfLines={1}>
                {meta}
              </Text>
            ) : null}
          </View>
          <Icon name="chevron-right" size={16} />
        </AnimatedPressable>
      </Link>
      <AnimatedPressable
        onPress={() => toggleFavourite.mutate({ libraryId, path: entry.path, on: !isFavourite })}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={
          isFavourite ? t('library.favourite.remove') : t('library.favourite.add')
        }
        className={`h-11 w-11 items-center justify-center ${ROW_SURFACE}`}
      >
        <Icon
          name={isFavourite ? 'heart-solid' : 'heart'}
          size={18}
          color={isFavourite ? colors.primary : undefined}
        />
      </AnimatedPressable>
    </View>
  );
}
