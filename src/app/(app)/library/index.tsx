import { Link } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';

import { useFavourites, useLibrariesAll, type SourcedLibrary } from '@/api/hooks';
import { Icon } from '@/components/ui/icon';
import { EmptyNote, ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useOpen } from '@/lib/open';
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
  const { libraries, isLoading, error } = useLibrariesAll();
  const { openLibrary } = useOpen();

  // Group libraries by their server (connection), preserving connection order.
  const groups: { id: string; name: string; libs: SourcedLibrary[] }[] = [];
  for (const lib of libraries) {
    let g = groups.find((x) => x.id === lib.connectionId);
    if (!g) {
      g = { id: lib.connectionId, name: lib.connectionName, libs: [] };
      groups.push(g);
    }
    g.libs.push(lib);
  }
  const showServerHeaders = groups.length > 1;

  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-0 p-4 lg:px-8">
      <Text variant="heading" className="mb-1">
        Library
      </Text>

      {isLoading ? <Spinner center /> : null}
      {error ? <ErrorNote message="Could not load libraries." /> : null}

      <FavouritesShelfRow />

      {groups.map((g) => (
        <View key={g.id}>
          {showServerHeaders ? (
            <Text variant="label" className="mb-1 mt-4">
              {g.name}
            </Text>
          ) : null}
          {g.libs.map((lib) => (
            <Pressable
              key={`${g.id}:${lib.id}`}
              onPress={() => void openLibrary(g.id, lib.id)}
              className="my-1 w-full flex-row items-center overflow-hidden rounded-lg bg-gray-50 shadow-sm active:opacity-80 dark:border dark:border-gray-900 dark:bg-gray-840 dark:shadow-none"
            >
              <View className="min-h-[3.5rem] items-center justify-center self-stretch bg-primary px-4">
                <Icon name="folder" size={20} color={colors.white} />
              </View>
              <View className="flex-1 px-5 py-2">
                <Text variant="subtitle">{lib.name}</Text>
                <Text variant="muted">{lib.default_view}</Text>
              </View>
              <Icon name="chevron-right" size={16} className="mr-4" />
            </Pressable>
          ))}
        </View>
      ))}

      {libraries.length === 0 && !isLoading ? (
        <EmptyNote message="No libraries are shared with your account yet." />
      ) : null}
    </ScrollView>
  );
}
