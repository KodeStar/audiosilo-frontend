import { Link } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useFavourites, useToggleFavourite } from '@/api/hooks';
import type { FsEntry } from '@/api/types';
import { Icon } from '@/components/ui/icon';
import { PressableRow } from '@/components/ui/row-surface';
import { Text } from '@/components/ui/text';
import { formatBitrate, formatDurationFull } from '@/lib/format';
import { bookHref, libraryHref } from '@/lib/paths';
import { useThemeColors } from '@/theme/use-theme-colors';

import { GlyphTile } from './glyph-tile';
/** One row in the filesystem browse view: a folder (muted glyph tile, drill in) or
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
  const themed = useThemeColors();
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
        <PressableRow
          accessibilityRole="link"
          className="flex-1 flex-row items-center gap-3 px-3 py-2"
        >
          <GlyphTile icon={isDir ? 'folder' : 'book'} tone={isDir ? 'muted' : 'info'} />
          <View className="flex-1">
            <Text variant="label" numberOfLines={1}>
              {title}
            </Text>
            {meta ? (
              <Text variant="caption" numberOfLines={1}>
                {meta}
              </Text>
            ) : null}
          </View>
          <Icon name="chevron-right" size={16} />
        </PressableRow>
      </Link>
      <PressableRow
        onPress={() => toggleFavourite.mutate({ libraryId, path: entry.path, on: !isFavourite })}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={
          isFavourite ? t('library.favourite.remove') : t('library.favourite.add')
        }
        className="h-11 w-11 items-center justify-center"
      >
        <Icon
          name={isFavourite ? 'heart-solid' : 'heart'}
          size={18}
          color={isFavourite ? themed.brand : undefined}
        />
      </PressableRow>
    </View>
  );
}
