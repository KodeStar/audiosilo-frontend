import { useTranslation } from 'react-i18next';
import { FlatList, View } from 'react-native';

import { useFavouritesAll, useToggleFavourite, type SourcedFavourite } from '@/api/hooks';
import { LayoutToggle } from '@/components/library/books/books-controls';
import { useBooksLayout } from '@/components/library/books/books-layout-store';
import { CoverGrid, CoverGridSkeleton, CoverListRow } from '@/components/library/cover-grid';
import { pageGutter } from '@/components/library/cover-layout';
import { CoverTile, useServerFlag } from '@/components/library/cover-tile';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { GhostCovers } from '@/components/ui/ghost-art';
import { Icon } from '@/components/ui/icon';
import { PressableRow } from '@/components/ui/row-surface';
import { Text } from '@/components/ui/text';
import { bookSubtitle } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { bookTitle, pathLeaf } from '@/lib/paths';
import { useThemeColors } from '@/theme/use-theme-colors';

const favKey = (f: SourcedFavourite) => `${f.connectionId}:${f.library_id}:${f.path}`;

/** The hearted books and folders of every connected server: folders as rows, books as a
 * cover grid or list (the device's grid/list choice). A book on another server than the
 * default carries its server's flag. */
export function FavouritesScreen() {
  const { t } = useTranslation();
  const layout = useLayout();
  const gutter = pageGutter(layout);
  const paddingBottom = useMiniPlayerInset();
  const [booksLayout, setBooksLayout] = useBooksLayout();
  const { favourites, isLoading, error } = useFavouritesAll();
  const books = favourites.filter((f) => f.is_book);
  const folders = favourites.filter((f) => !f.is_book);
  const serverFlag = useServerFlag();
  const server = (f: SourcedFavourite) => serverFlag(f.connectionId);

  const header = (
    <View className="gap-4 pb-5 pt-2">
      <View className="flex-row items-end justify-between gap-3">
        <View className="flex-1 gap-1">
          <Text variant="display" accessibilityRole="header">
            {t('library.favourites.title')}
          </Text>
          {isLoading ? null : (
            <Text variant="caption">
              {t('library.favourites.itemCount', { count: favourites.length })}
            </Text>
          )}
        </View>
        {books.length > 0 ? <LayoutToggle value={booksLayout} onChange={setBooksLayout} /> : null}
      </View>
      {folders.length > 0 ? (
        <View className="gap-1">
          <Text variant="eyebrow" className="pb-1">
            {t('library.favourites.folders')}
          </Text>
          {folders.map((f) => (
            <FolderRow key={favKey(f)} fav={f} />
          ))}
          {books.length > 0 ? (
            <Text variant="eyebrow" className="pt-4">
              {t('library.favourites.books')}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  const themed = useThemeColors();
  const empty = isLoading ? (
    <CoverGridSkeleton rows={2} gutter={0} />
  ) : folders.length > 0 ? null : error ? (
    <EmptyState
      variant="card"
      art={<Icon name="circle-exclamation" size={28} color={themed.destructive} />}
      title={t('library.favourites.error')}
      hint={t('library.favourites.errorHint')}
    />
  ) : (
    <EmptyState
      variant="card"
      art={<GhostCovers />}
      title={t('library.favourites.empty')}
      hint={t('library.favourites.emptyHint')}
    />
  );

  if (booksLayout === 'grid') {
    return (
      <CoverGrid
        data={books}
        keyExtractor={favKey}
        renderItem={(f, tile) => (
          <CoverTile
            connectionId={f.connectionId}
            libraryId={f.library_id}
            path={f.path}
            title={bookTitle(f.title, f.path)}
            author={f.author}
            caption={f.author}
            server={server(f)}
            width={tile}
          />
        )}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
      />
    );
  }
  return (
    <FlatList
      data={books}
      keyExtractor={favKey}
      renderItem={({ item }) => <BookRow fav={item} server={server(item)} />}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: 4, paddingBottom }}
    />
  );
}

/** Takes a favourite off its own server's list. A sibling of the row's press, never
 * nested in it. */
function UnfavouriteButton({ fav }: { fav: SourcedFavourite }) {
  const { t } = useTranslation();
  const toggle = useToggleFavourite(fav.connectionId);
  return (
    <Button
      variant="ghost"
      size="icon"
      icon="heart-solid"
      accessibilityLabel={t('library.favourite.remove')}
      onPress={() => toggle.mutate({ libraryId: fav.library_id, path: fav.path, on: false })}
    />
  );
}

/** A hearted book in the list layout. */
function BookRow({ fav, server }: { fav: SourcedFavourite; server?: string }) {
  const { openBook } = useOpen();
  const subtitle = [
    bookSubtitle({ author: fav.author, series: fav.series, seriesIndex: fav.series_index }),
    server,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <CoverListRow
      connectionId={fav.connectionId}
      libraryId={fav.library_id}
      path={fav.path}
      title={bookTitle(fav.title, fav.path)}
      author={fav.author}
      subtitle={subtitle}
      onPress={() => openBook(fav.connectionId, fav.library_id, fav.path)}
      trailing={<UnfavouriteButton fav={fav} />}
    />
  );
}

/** A hearted folder: opens it in the folder browser. */
function FolderRow({ fav }: { fav: SourcedFavourite }) {
  const themed = useThemeColors();
  const { openLibrary } = useOpen();
  return (
    <View className="flex-row items-center gap-2">
      <PressableRow
        onPress={() => openLibrary(fav.connectionId, fav.library_id, fav.path)}
        accessibilityRole="button"
        className="min-h-[56px] flex-1 flex-row items-center gap-3 px-3 py-2"
      >
        <View className="h-10 w-10 items-center justify-center rounded-lg bg-muted">
          <Icon name="folder" size={18} color={themed.mutedForeground} />
        </View>
        <View className="flex-1">
          <Text variant="label" numberOfLines={1}>
            {pathLeaf(fav.path)}
          </Text>
          {fav.path !== pathLeaf(fav.path) ? (
            <Text variant="caption" numberOfLines={1}>
              {fav.path}
            </Text>
          ) : null}
        </View>
      </PressableRow>
      <UnfavouriteButton fav={fav} />
    </View>
  );
}
