import { Link } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';

import { useFavourites, useToggleFavourite } from '@/api/hooks';
import type { Favourite } from '@/api/types';
import { Icon } from '@/components/ui/icon';
import { EmptyNote, ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { bookSubtitle } from '@/lib/format';
import { bookHref, libraryHref, pathLeaf } from '@/lib/paths';
import { colors } from '@/theme/tokens';

/** Filled heart that un-favourites the path it's given. Always a sibling of (never
 * nested inside) the navigable row, so its press can't bubble into a navigation. */
function UnfavouriteButton({ libraryId, path }: { libraryId: number; path: string }) {
  const toggleFavourite = useToggleFavourite();
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

/** One favourite as a row, styled like the browse list: a book (blue block, opens
 * the book) or a navigation folder (pink block, drills in), with a remove-heart. */
function FavouriteRow({ fav }: { fav: Favourite }) {
  const isBook = fav.is_book;
  const href = isBook ? bookHref(fav.library_id, fav.path) : libraryHref(fav.library_id, fav.path);
  const title = fav.title || pathLeaf(fav.path);
  const meta = isBook
    ? bookSubtitle({ author: fav.author, series: fav.series, seriesIndex: fav.series_index }) ||
      fav.path
    : fav.path;
  return (
    <View className="my-1 w-full flex-row items-center overflow-hidden rounded-lg bg-gray-50 shadow-sm dark:border dark:border-gray-900 dark:bg-gray-840 dark:shadow-none">
      <Link href={href} asChild>
        <Pressable className="flex-1 flex-row items-center self-stretch active:opacity-80">
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
      </Link>
      <UnfavouriteButton libraryId={fav.library_id} path={fav.path} />
    </View>
  );
}

/** The Favourites "shelf" screen (reached from the Libraries list). Everything is
 * a row here (no cover cards — those are only on the home screen). */
export default function FavouritesScreen() {
  const { data: favourites, isLoading, error, refetch } = useFavourites();
  const items = favourites ?? [];

  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-0 p-4 px-8">
      <Text variant="heading" className="mb-1">
        Favourites
      </Text>

      {isLoading ? <Spinner center /> : null}
      {error ? (
        <ErrorNote message="Could not load your favourites." onRetry={() => refetch()} />
      ) : null}
      {!isLoading && !error && items.length === 0 ? (
        <EmptyNote message="Tap the heart on a folder or book to add it here." />
      ) : null}

      {items.map((f) => (
        <FavouriteRow key={`${f.library_id}:${f.path}`} fav={f} />
      ))}
    </ScrollView>
  );
}
