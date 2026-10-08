import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useCollections, useFavouritesAll } from '@/api/hooks';
import { TabPageScroll } from '@/components/shell/tab-page-scroll';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { bookTitle } from '@/lib/paths';

import { LoadError } from '../books/book-states';
import {
  CollectionCard,
  CollectionCardFrame,
  CollectionCardSkeleton,
  CoverFan,
  NewCollectionCard,
} from '../collections/collection-card';
import { CollectionFormDialog } from '../collections/collection-dialogs';
import { collectionGrid } from '../collections/collections-model';
import { pageGutter } from '../cover-layout';
import type { LibraryModeProps } from '../library-modes';

/**
 * The Library tab's Collections mode (capability `collections`): Favourites first (a
 * built-in card for the hearted books of every server), then the listener's own
 * collections and the ones shared with them (the server's order), then New collection.
 * Collections belong to a server, not a library, so the library picker doesn't filter
 * them.
 */
export function CollectionsMode({ connectionId }: LibraryModeProps) {
  const { t } = useTranslation();
  const layout = useLayout();
  const gutter = pageGutter(layout);
  const { openCollection } = useOpen();
  const { data, isLoading, error, refetch } = useCollections(connectionId);
  const { favourites } = useFavouritesAll();
  const [creating, setCreating] = useState(false);
  const [width, setWidth] = useState(0);
  const { card, gap } = collectionGrid(Math.max(0, width - gutter * 2), layout);

  const favouriteBooks = favourites.filter((f) => f.is_book).slice(0, 3);

  return (
    <TabPageScroll
      gutter={false}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: 20 }}
    >
      {error && !data ? (
        <View className="pb-6">
          <LoadError
            compact
            title={t('library.collections.error')}
            retryLabel={t('common.retry')}
            onRetry={() => void refetch()}
          />
        </View>
      ) : null}
      {width > 0 ? (
        <View className="flex-row flex-wrap" style={{ columnGap: gap, rowGap: gap + 8 }}>
          <CollectionCardFrame
            width={card}
            title={t('library.favourites.title')}
            icon="heart"
            lines={[
              t('library.favourites.itemCount', { count: favourites.length }),
              t('library.collections.favouritesHint'),
            ]}
            onPress={() => router.push('/library/favourites')}
            art={
              <CoverFan
                width={card}
                covers={favouriteBooks.map((f) => ({
                  connectionId: f.connectionId,
                  libraryId: f.library_id,
                  path: f.path,
                  title: bookTitle(f.title, f.path),
                  author: f.author,
                }))}
              />
            }
          />
          {isLoading
            ? [0, 1].map((i) => <CollectionCardSkeleton key={i} width={card} />)
            : (data ?? []).map((c) => (
                <CollectionCard
                  key={c.id}
                  connectionId={connectionId}
                  collection={c}
                  width={card}
                  onPress={() => openCollection(connectionId, c.id)}
                />
              ))}
          {data ? <NewCollectionCard width={card} onPress={() => setCreating(true)} /> : null}
        </View>
      ) : null}
      {creating ? (
        <CollectionFormDialog
          open={creating}
          onOpenChange={setCreating}
          connectionId={connectionId}
          onSaved={(c) => openCollection(connectionId, c.id)}
        />
      ) : null}
    </TabPageScroll>
  );
}
