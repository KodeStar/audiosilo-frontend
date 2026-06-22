import { Pressable, ScrollView, View } from 'react-native';

import { useFavouritesAll, useToggleFavourite, type SourcedFavourite } from '@/api/hooks';
import { Icon } from '@/components/ui/icon';
import { EmptyNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { bookSubtitle } from '@/lib/format';
import { useOpen } from '@/lib/open';
import { pathLeaf } from '@/lib/paths';
import { colors } from '@/theme/tokens';

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
  const toggleFavourite = useToggleFavourite(connectionId);
  return (
    <Pressable
      onPress={() => toggleFavourite.mutate({ libraryId, path, on: false })}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel="Remove from favourites"
      className="self-stretch justify-center pl-2 pr-4 active:opacity-60"
    >
      <Icon name="heart-solid" size={18} color={colors.primary} />
    </Pressable>
  );
}

/** One favourite as a row, styled like the browse list: a book (blue block) or a
 * navigation folder (pink block), opened on its own connection, with a remove-heart. */
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
    <View className="my-1 w-full flex-row items-center overflow-hidden rounded-lg bg-gray-50 shadow-sm dark:border dark:border-gray-900 dark:bg-gray-840 dark:shadow-none">
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        className="flex-1 flex-row items-center self-stretch active:opacity-80"
      >
        <View
          className={`min-h-[3.5rem] items-center justify-center self-stretch px-4 ${isBook ? 'bg-blue-500' : 'bg-primary'}`}
        >
          <Icon name={isBook ? 'book' : 'folder'} size={20} color={colors.white} />
        </View>
        <View className="flex-1 px-5 py-2">
          <Text variant="subtitle" numberOfLines={1}>
            {title}
          </Text>
          {meta ? (
            <Text variant="muted" numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
      </Pressable>
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
  const { favourites, isLoading } = useFavouritesAll();

  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-0 p-4 lg:px-8">
      <Text variant="heading" className="mb-1">
        Favourites
      </Text>

      {isLoading ? <Spinner center /> : null}
      {!isLoading && favourites.length === 0 ? (
        <EmptyNote message="Tap the heart on a folder or book to add it here." />
      ) : null}

      {favourites.map((f) => (
        <FavouriteRow key={`${f.connectionId}:${f.library_id}:${f.path}`} fav={f} />
      ))}
    </ScrollView>
  );
}
