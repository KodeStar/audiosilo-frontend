import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, View } from 'react-native';

import { ApiError } from '@/api/client';
import {
  useAddCollectionItem,
  useAllProgressAll,
  useCapability,
  useCollection,
  useDeleteCollection,
  useRemoveCollectionItem,
} from '@/api/hooks';
import { useCid } from '@/api/provider';
import type { Collection, CollectionItem, Progress } from '@/api/types';
import { ContentScope } from '@/components/layout/content-scope';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { formatDuration } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { parseCollectionParams, pathLeaf } from '@/lib/paths';
import { useSession } from '@/stores/session';
import { tabularNums } from '@/theme/tabular-nums';

import type { BookAction } from './books/book-actions';
import { BookListHeader, BookListRow, BookTile } from './books/book-items';
import { GhostCovers, LoadError, StateNotice } from './books/book-states';
import { LayoutToggle } from './books/books-controls';
import { useBooksLayout } from './books/books-layout-store';
import { useShareText } from './collections/collection-card';
import {
  collectionFailed,
  CollectionFormDialog,
  ShareCollectionDialog,
} from './collections/collection-dialogs';
import { moveIndex, shareLine, totalDuration } from './collections/collections-model';
import { CoverGrid, CoverGridSkeleton, CoverListRow } from './cover-grid';
import { coverGridMetrics, pageGutter } from './cover-layout';
import { CoverTile } from './cover-tile';

/**
 * A collection page: `/collection?connection=&id=` (`collectionHref`). Scoped to its
 * own `?connection=`.
 */
export function CollectionScreen() {
  return (
    <ContentScope>
      <CollectionContent />
    </ContentScope>
  );
}

const itemKey = (i: CollectionItem) => `${i.library_id}:${i.path}`;

function CollectionContent() {
  const { t } = useTranslation();
  const params = parseCollectionParams(useLocalSearchParams());
  const cid = useCid();
  const supported = useCapability('collections', cid);
  const query = useCollection(params?.id ?? 0, cid);

  if (!params || supported === false || isGone(query.error)) {
    return (
      <Centered>
        <StateNotice
          art={<GhostCovers />}
          title={t('library.collection.notFound.title')}
          hint={t('library.collection.notFound.hint')}
          action={{ label: t('library.collection.notFound.action'), onPress: backToCollections }}
        />
      </Centered>
    );
  }
  if (!query.data) {
    return query.error ? (
      <Centered>
        <LoadError
          title={t('library.collection.error')}
          retryLabel={t('common.retry')}
          onRetry={() => void query.refetch()}
        />
      </Centered>
    ) : (
      <CollectionSkeleton />
    );
  }
  return (
    <CollectionBody
      connectionId={cid}
      collection={query.data.collection}
      items={query.data.items}
    />
  );
}

/** A 404: the collection was deleted, or it is no longer shared with the listener. */
const isGone = (e: unknown) => e instanceof ApiError && e.status === 404;

/** Leave a deleted or left collection: back to where it was opened from, else to the
 * Collections mode. */
function backToCollections() {
  if (router.canGoBack()) router.back();
  else router.replace({ pathname: '/library', params: { mode: 'collections' } });
}

function Centered({ children }: { children: React.ReactNode }) {
  return <View className="flex-1 p-4 lg:px-8">{children}</View>;
}

function CollectionSkeleton() {
  return (
    <View className="flex-1 gap-3 pt-4">
      <View className="gap-2 px-4 lg:px-8">
        <Skeleton className="h-3 w-20 rounded-sm" />
        <Skeleton className="h-8 w-1/2 rounded-md" />
        <Skeleton className="h-3.5 w-1/3 rounded-sm" />
      </View>
      <CoverGridSkeleton rows={2} />
    </View>
  );
}

/** The page once the collection is in: header, then its items as a grid or a list. */
function CollectionBody({
  connectionId,
  collection,
  items,
}: {
  connectionId: string;
  collection: Collection;
  items: CollectionItem[];
}) {
  const { t } = useTranslation();
  const layout = useLayout();
  const gutter = pageGutter(layout);
  const paddingBottom = useMiniPlayerInset();
  const [booksLayout, setBooksLayout] = useBooksLayout();
  const { openBook } = useOpen();
  const add = useAddCollectionItem(connectionId);
  const remove = useRemoveCollectionItem(connectionId);
  const owned = collection.owned;

  const { progress } = useAllProgressAll();
  const progressOf = useMemo(() => {
    const map = new Map<string, Progress>();
    for (const p of progress) {
      if (p.connectionId === connectionId) map.set(`${p.library_id}:${p.path}`, p);
    }
    return (i: CollectionItem) => map.get(itemKey(i));
  }, [progress, connectionId]);

  const moveTo = (item: CollectionItem, to: number) =>
    add
      .mutateAsync({ id: collection.id, libraryId: item.library_id, path: item.path, position: to })
      .catch((e: unknown) => collectionFailed(e, t));

  const removeItem = (item: CollectionItem, index: number) =>
    remove.mutateAsync({ id: collection.id, libraryId: item.library_id, path: item.path }).then(
      () =>
        toast({
          title: t('library.collection.removed', { name: collection.name }),
          action: { label: t('queue.undo'), onPress: () => void moveTo(item, index) },
        }),
      (e: unknown) => collectionFailed(e, t),
    );

  /** The owner's per-item actions: move up and down (positioned adds at the visible
   * index, never a whole-list replace, which would drop items hidden from them) and
   * remove (by the item's own path). */
  const itemActions = (item: CollectionItem, index: number): BookAction[] => {
    if (!owned) return [];
    const up = moveIndex(index, -1, items.length);
    const down = moveIndex(index, 1, items.length);
    return [
      ...(up === null
        ? []
        : [
            {
              key: 'up',
              icon: 'chevron-up' as const,
              label: t('library.collection.moveUp'),
              onPress: () => void moveTo(item, up),
              group: true,
            },
          ]),
      ...(down === null
        ? []
        : [
            {
              key: 'down',
              icon: 'chevron-down' as const,
              label: t('library.collection.moveDown'),
              onPress: () => void moveTo(item, down),
              group: up === null,
            },
          ]),
      {
        key: 'remove',
        icon: 'trash',
        label: t('library.collection.remove'),
        onPress: () => void removeItem(item, index),
        destructive: true,
        group: items.length < 2,
      },
    ];
  };

  const header = (
    <CollectionHeader
      connectionId={connectionId}
      collection={collection}
      items={items}
      layoutToggle={<LayoutToggle value={booksLayout} onChange={setBooksLayout} />}
    />
  );
  const empty = (
    <StateNotice
      art={<GhostCovers />}
      title={t('library.collection.empty.title')}
      hint={
        owned
          ? t('library.collection.empty.hint')
          : t('library.collection.empty.viewerHint', { owner: collection.owner.username })
      }
    />
  );

  if (booksLayout === 'grid') {
    const inset = coverGridMetrics(0, layout).columnGap / 2;
    return (
      <CoverGrid
        data={items}
        keyExtractor={itemKey}
        renderItem={(item, tile) =>
          item.book ? (
            <BookTile
              connectionId={connectionId}
              libraryId={item.library_id}
              book={item.book}
              progress={progressOf(item)}
              width={tile}
            />
          ) : (
            <CoverTile
              connectionId={connectionId}
              libraryId={item.library_id}
              path={item.path}
              title={pathLeaf(item.path)}
              width={tile}
            />
          )
        }
        ListHeaderComponent={<View style={{ paddingHorizontal: inset }}>{header}</View>}
        ListEmptyComponent={<View style={{ paddingHorizontal: inset }}>{empty}</View>}
      />
    );
  }
  return (
    <FlatList
      data={items}
      keyExtractor={itemKey}
      renderItem={({ item, index }) =>
        item.book ? (
          <BookListRow
            connectionId={connectionId}
            libraryId={item.library_id}
            book={item.book}
            progress={progressOf(item)}
            extra={itemActions(item, index)}
          />
        ) : (
          <CoverListRow
            connectionId={connectionId}
            libraryId={item.library_id}
            path={item.path}
            title={pathLeaf(item.path)}
            subtitle={t('library.collection.notIndexed')}
            onPress={() => openBook(connectionId, item.library_id, item.path)}
            trailing={
              owned ? (
                <Button
                  variant="ghost"
                  size="icon"
                  icon="trash"
                  accessibilityLabel={t('library.collection.remove')}
                  onPress={() => void removeItem(item, index)}
                />
              ) : null
            }
          />
        )
      }
      ListHeaderComponent={
        <View>
          {header}
          {layout !== 'phone' && items.length > 0 ? <BookListHeader /> : null}
        </View>
      }
      ListEmptyComponent={empty}
      contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: 4, paddingBottom }}
    />
  );
}

/** Name, description, who it's shared with or by, the count and total length, and the
 * actions: Edit / Share / Delete for the owner (Share hidden for a demo account), Leave
 * for a viewer. */
function CollectionHeader({
  connectionId,
  collection,
  items,
  layoutToggle,
}: {
  connectionId: string;
  collection: Collection;
  items: CollectionItem[];
  layoutToggle: React.ReactElement;
}) {
  const { t } = useTranslation();
  const shareText = useShareText();
  const isDemo = useSession(
    (s) => !!s.connections.find((c) => c.id === connectionId)?.user?.is_demo,
  );
  const remove = useDeleteCollection(connectionId);
  const [dialog, setDialog] = useState<null | 'edit' | 'share' | 'delete' | 'leave'>(null);
  const close = () => setDialog(null);
  const owned = collection.owned;
  const length = formatDuration(totalDuration(items));
  const stats = [
    t('library.collections.itemCount', { count: collection.item_count }),
    length ? t('library.collection.total', { length }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const share = shareText(shareLine(collection));

  const destroy = () => {
    close();
    remove.mutateAsync(collection.id).then(
      () => {
        toast({
          title: t(owned ? 'library.collection.deleted' : 'library.collection.left', {
            name: collection.name,
          }),
        });
        backToCollections();
      },
      (e: unknown) => collectionFailed(e, t),
    );
  };

  return (
    <View className="gap-4 pb-6 pt-2">
      <View className="gap-1.5">
        <Text variant="eyebrow">{t('library.detail.collection')}</Text>
        <Text variant="display" accessibilityRole="header">
          {collection.name}
        </Text>
        {collection.description ? (
          <Text variant="muted" className="max-w-[720px]">
            {collection.description}
          </Text>
        ) : null}
        <Text variant="caption" style={tabularNums}>
          {[stats, share].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        {owned ? (
          <>
            <Button
              variant="outline"
              size="sm"
              icon="pen"
              title={t('library.collection.edit')}
              onPress={() => setDialog('edit')}
            />
            {isDemo ? null : (
              <Button
                variant="outline"
                size="sm"
                icon="share"
                title={t('library.collection.share.action')}
                onPress={() => setDialog('share')}
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              icon="trash"
              title={t('library.collection.delete')}
              onPress={() => setDialog('delete')}
            />
          </>
        ) : (
          <Button
            variant="outline"
            size="sm"
            icon="logout"
            title={t('library.collection.leave')}
            onPress={() => setDialog('leave')}
          />
        )}
        <View className="ml-auto">{layoutToggle}</View>
      </View>
      {dialog === 'edit' ? (
        <CollectionFormDialog
          open
          onOpenChange={(o) => !o && close()}
          connectionId={connectionId}
          collection={collection}
        />
      ) : null}
      {dialog === 'share' ? (
        <ShareCollectionDialog
          open
          onOpenChange={(o) => !o && close()}
          connectionId={connectionId}
          collection={collection}
        />
      ) : null}
      <ConfirmDialog
        visible={dialog === 'delete' || dialog === 'leave'}
        title={t(
          dialog === 'leave'
            ? 'library.collection.leaveConfirm.title'
            : 'library.collection.deleteConfirm.title',
          { name: collection.name },
        )}
        message={t(
          dialog === 'leave'
            ? 'library.collection.leaveConfirm.message'
            : 'library.collection.deleteConfirm.message',
          { owner: collection.owner.username },
        )}
        confirmLabel={t(
          dialog === 'leave' ? 'library.collection.leave' : 'library.collection.delete',
        )}
        confirmIcon={dialog === 'leave' ? 'logout' : 'trash'}
        destructive
        onConfirm={destroy}
        onCancel={close}
      />
    </View>
  );
}
