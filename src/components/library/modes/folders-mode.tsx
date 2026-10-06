import { Link } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { useFavouritesAll, useLibrariesAll, type SourcedLibrary } from '@/api/hooks';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { ErrorNote } from '@/components/ui/query-state';
import { PressableRow } from '@/components/ui/row-surface';
import { RowSkeletonList } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useOpen } from '@/lib/open';
import { useThemeColors } from '@/theme/use-theme-colors';

// The quiet row's layout (the surface itself is PressableRow's).
const ROW = 'my-1 w-full flex-row items-center gap-3 px-3 py-2.5';
const GLYPH = 'h-10 w-10 items-center justify-center rounded-lg';

/** Favourites sits alongside the libraries as a special "shelf": a row that opens
 * the dedicated Favourites screen. Always shown so it stays discoverable. */
function FavouritesShelfRow() {
  const themed = useThemeColors();
  const { t } = useTranslation();
  const { favourites } = useFavouritesAll();
  const count = favourites.length;
  return (
    <Link href="/library/favourites" asChild>
      <PressableRow accessibilityRole="link" className={ROW}>
        <View className={`${GLYPH} bg-brand/10`}>
          <Icon name="heart-solid" size={18} color={themed.brand} />
        </View>
        <View className="flex-1">
          <Text variant="label">{t('library.favourites.title')}</Text>
          <Text variant="muted">
            {count === 0
              ? t('library.favourites.emptyHint')
              : t('library.favourites.itemCount', { count })}
          </Text>
        </View>
        <Icon name="chevron-right" size={16} />
      </PressableRow>
    </Link>
  );
}

export default function LibrariesScreen() {
  const themed = useThemeColors();
  const { t } = useTranslation();
  const { libraries, isLoading, error } = useLibrariesAll();
  const { openLibrary } = useOpen();
  const paddingBottom = useMiniPlayerInset();

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
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-0 p-4 lg:px-8"
      contentContainerStyle={{ paddingBottom }}
    >
      {isLoading ? <RowSkeletonList /> : null}
      {error ? <ErrorNote message={t('library.list.loadLibrariesError')} /> : null}

      <FavouritesShelfRow />

      {groups.map((g) => (
        <View key={g.id}>
          {showServerHeaders ? (
            <Text variant="eyebrow" className="mb-1 mt-4">
              {g.name}
            </Text>
          ) : null}
          {g.libs.map((lib) => (
            <PressableRow
              key={`${g.id}:${lib.id}`}
              onPress={() => void openLibrary(g.id, lib.id)}
              accessibilityRole="button"
              className={ROW}
            >
              <View className={`${GLYPH} bg-brand/10`}>
                <Icon name="folder" size={18} color={themed.brand} />
              </View>
              <View className="flex-1">
                <Text variant="label">{lib.name}</Text>
                <Text variant="muted">{lib.default_view}</Text>
              </View>
              <Icon name="chevron-right" size={16} />
            </PressableRow>
          ))}
        </View>
      ))}

      {libraries.length === 0 && !isLoading ? (
        <EmptyState
          icon="library"
          title={t('library.list.noLibraries')}
          hint={t('library.list.noLibrariesHint')}
        />
      ) : null}
    </ScrollView>
  );
}
