import { Link } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';

import { useFavourites, useLibraries } from '@/api/hooks';
import { Icon } from '@/components/ui/icon';
import { EmptyNote, ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { libraryHref } from '@/lib/paths';
import { colors } from '@/theme/tokens';

/** Favourites sits alongside the libraries as a special "shelf": a row that opens
 * the dedicated Favourites screen. Always shown so it stays discoverable. */
function FavouritesShelfRow() {
  const { data: favourites } = useFavourites();
  const count = favourites?.length ?? 0;
  return (
    <Link href="/library/favourites" asChild>
      <Pressable className="my-1 w-full flex-row items-center overflow-hidden rounded-lg bg-gray-50 shadow-sm active:opacity-80 dark:border dark:border-gray-900 dark:bg-gray-840 dark:shadow-none">
        <View className="min-h-[3.5rem] items-center justify-center self-stretch bg-primary px-4">
          <Icon name="heart-solid" size={20} color={colors.white} />
        </View>
        <View className="flex-1 px-5 py-2">
          <Text variant="subtitle">Favourites</Text>
          <Text variant="muted">
            {count === 0
              ? 'Tap the heart on any item to curate'
              : `${count} item${count === 1 ? '' : 's'}`}
          </Text>
        </View>
        <Icon name="chevron-right" size={16} className="mr-4" />
      </Pressable>
    </Link>
  );
}

export default function LibrariesScreen() {
  const { data: libraries, isLoading, error, refetch } = useLibraries();

  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-0 p-4 px-8">
      <Text variant="heading" className="mb-1">
        Libraries
      </Text>

      {isLoading ? <Spinner center /> : null}
      {error ? <ErrorNote message="Could not load libraries." onRetry={() => refetch()} /> : null}

      <FavouritesShelfRow />

      {libraries?.map((lib) => (
        <Link key={lib.id} href={libraryHref(lib.id)} asChild>
          <Pressable className="my-1 w-full flex-row items-center overflow-hidden rounded-lg bg-gray-50 shadow-sm active:opacity-80 dark:border dark:border-gray-900 dark:bg-gray-840 dark:shadow-none">
            <View
              className={`min-h-[3.5rem] items-center justify-center self-stretch px-4 bg-primary`}
            >
              <Icon name={'folder'} size={20} color={colors.white} />
            </View>

            <View className="flex-1 px-5 py-2">
              <Text variant="subtitle">{lib.name}</Text>
              <Text variant="muted">
                {lib.default_view} · {lib.layout}
              </Text>
            </View>
            <Icon name="chevron-right" size={16} className="mr-4" />
          </Pressable>
        </Link>
      ))}

      {libraries?.length === 0 ? (
        <EmptyNote message="No libraries are shared with your account yet." />
      ) : null}
    </ScrollView>
  );
}
