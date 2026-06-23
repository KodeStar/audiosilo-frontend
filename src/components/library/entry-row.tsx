import { Link } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { useFavourites, useToggleFavourite } from '@/api/hooks';
import type { FsEntry } from '@/api/types';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatBitrate, formatDurationFull } from '@/lib/format';
import { bookHref, libraryHref } from '@/lib/paths';
import { colors } from '@/theme/tokens';

/** One row in the filesystem browse view: a folder (pink block, drill in) or an
 * audio file (blue block, opens the book). Ported from the old client's list. */
export function EntryRow({ entry, libraryId }: { entry: FsEntry; libraryId: number }) {
  const { t } = useTranslation();
  const isDir = entry.is_dir;
  const { data: favourites } = useFavourites();
  const toggleFavourite = useToggleFavourite();
  const isFavourite = !!favourites?.some(
    (f) => f.library_id === libraryId && f.path === entry.path,
  );
  // Plain folders drill in; book folders and audio leaves open the book screen.
  const href =
    isDir && !entry.is_book ? libraryHref(libraryId, entry.path) : bookHref(libraryId, entry.path);
  // Show what's on disk — the name the user gave the folder/file — as the title,
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
  // + chevron) and the heart are siblings within the card.
  return (
    <View className="my-1 w-full flex-row items-center overflow-hidden rounded-lg bg-gray-50 shadow-sm dark:border dark:border-gray-900 dark:bg-gray-840 dark:shadow-none">
      <Link href={href} asChild>
        <Pressable className="flex-1 flex-row pr-4 items-center self-stretch active:opacity-80">
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
          <Icon name="chevron-right" size={16} className="mr-2" />
        </Pressable>
      </Link>
      <Pressable
        onPress={() => toggleFavourite.mutate({ libraryId, path: entry.path, on: !isFavourite })}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={
          isFavourite ? t('library.favourite.remove') : t('library.favourite.add')
        }
        className="self-stretch justify-center px-4 active:opacity-60 bg-black/5 dark:bg-black/15"
      >
        <Icon
          name={isFavourite ? 'heart-solid' : 'heart'}
          size={18}
          color={isFavourite ? colors.primary : undefined}
        />
      </Pressable>
    </View>
  );
}
