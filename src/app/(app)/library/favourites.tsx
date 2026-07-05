import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { useFavouritesAll, useToggleFavourite, type SourcedFavourite } from '@/api/hooks';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { bookSubtitle } from '@/lib/format';
import { useOpen } from '@/lib/open';
import { pathLeaf } from '@/lib/paths';
import { colors } from '@/theme/tokens';

const ROW_SURFACE =
  'rounded-xl bg-white shadow-sm dark:border dark:border-gray-750 dark:bg-gray-840 dark:shadow-none';

/** Filled heart that un-favourites the path on its own connection. Always a
 * sibling of (never nested inside) the navigable row, so its press can't bubble. */
function UnfavouriteButton({
  connectionId,
  libraryId,
  path,
}: {
  connectionId: string;
  libraryId: number;
  path: string;
}) {
  const { t } = useTranslation();
  const toggleFavourite = useToggleFavourite(connectionId);
  return (
    <AnimatedPressable
      onPress={() => toggleFavourite.mutate({ libraryId, path, on: false })}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('library.favourite.remove')}
      className={`h-11 w-11 items-center justify-center ${ROW_SURFACE}`}
    >
      <Icon name="heart-solid" size={18} color={colors.primary} />
    </AnimatedPressable>
  );
}

/** One favourite as a quiet row: a book (blue glyph tile) or a navigation folder
 * (pink glyph tile), opened on its own connection, with a remove-heart. */
function FavouriteRow({ fav }: { fav: SourcedFavourite }) {
  const { openBook, openLibrary } = useOpen();
  const isBook = fav.is_book;
  const title = fav.title || pathLeaf(fav.path);
  const meta = isBook
    ? bookSubtitle({ author: fav.author, series: fav.series, seriesIndex: fav.series_index }) ||
      fav.path
    : fav.path;
  const onPress = () =>
    isBook
      ? void openBook(fav.connectionId, fav.library_id, fav.path)
      : void openLibrary(fav.connectionId, fav.library_id, fav.path);
  return (
    <View className="my-1 w-full flex-row items-center gap-2">
      <AnimatedPressable
        onPress={onPress}
        accessibilityRole="button"
        className={`flex-1 flex-row items-center gap-3 px-3 py-2.5 ${ROW_SURFACE}`}
      >
        <View
          className={`h-10 w-10 items-center justify-center rounded-lg ${isBook ? 'bg-blue-500/10 dark:bg-blue-500/15' : 'bg-primary/10'}`}
        >
          <Icon
            name={isBook ? 'book' : 'folder'}
            size={18}
            color={isBook ? colors.blue : colors.primary}
          />
        </View>
        <View className="flex-1">
          <Text variant="subtitle" numberOfLines={1}>
            {title}
          </Text>
          {meta ? (
            <Text variant="muted" numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
      </AnimatedPressable>
      <UnfavouriteButton
        connectionId={fav.connectionId}
        libraryId={fav.library_id}
        path={fav.path}
      />
    </View>
  );
}

/** The Favourites shelf screen (reached from the Libraries list), aggregated
 * across every connected server. Everything is a row here (no cover cards). */
export default function FavouritesScreen() {
  const { t } = useTranslation();
  const { favourites, isLoading } = useFavouritesAll();
  const paddingBottom = useMiniPlayerInset();

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-0 p-4 lg:px-8"
      contentContainerStyle={{ paddingBottom }}
    >
      <Text variant="heading" className="mb-1">
        {t('library.favourites.title')}
      </Text>

      {isLoading ? (
        <View className="gap-2 pt-1">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        </View>
      ) : null}
      {!isLoading && favourites.length === 0 ? (
        <EmptyState
          icon="heart"
          title={t('library.favourites.empty')}
          hint={t('library.favourites.emptyHint')}
        />
      ) : null}

      {favourites.map((f) => (
        <FavouriteRow key={`${f.connectionId}:${f.library_id}:${f.path}`} fav={f} />
      ))}
    </ScrollView>
  );
}
