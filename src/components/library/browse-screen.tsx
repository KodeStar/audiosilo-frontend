import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, type ListRenderItem, Pressable, type ViewToken, View } from 'react-native';

import { useBrowseInfinite, useLibraries } from '@/api/hooks';
import { useScopedCid } from '@/api/provider';
import type { FsEntry } from '@/api/types';
import { ContentScope } from '@/components/layout/content-scope';
import { EntryRow } from '@/components/library/entry-row';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { BreadCrumbs, type Crumb } from '@/components/ui/breadcrumbs';
import { EmptyNote, ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { TextField } from '@/components/ui/text-field';
import {
  filterEntries,
  groupByLetter,
  presentLetters,
  RAIL_LETTERS,
  sectionIndexForLetter,
} from '@/lib/alpha-sections';
import { libraryHref, segmentsToPath } from '@/lib/paths';
import { recallScroll, rememberScroll, scrollKey } from '@/lib/scroll-memory';

// Show the filter box + A–Z rail only once a folder is big enough to need them.
const NARROW_THRESHOLD = 25;
// Stable across renders (FlatList rejects a changing viewability config).
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 10 };
// Fixed row heights drive getItemLayout, so the A–Z rail can jump to an exact
// offset (a folder/file row is EntryRow's min-h-[3.5rem]=56 + my-1=8).
const HEADER_H = 48;
const ENTRY_H = 64;

/** A flattened browse row: a letter divider or a filesystem entry. */
type Row = { type: 'header'; letter: string } | { type: 'entry'; entry: FsEntry };

/**
 * Filesystem browse view, shared by the library root (`index.tsx`) and the
 * nested catch-all (`[...path].tsx`). The optional `path` param is absent at the
 * root and a segment array once the user drills into folders.
 *
 * The whole folder is fetched (page-by-page) and rendered in a virtualized
 * `FlatList` grouped into first-letter sections, so a library root with thousands
 * of author folders stays fast and fully reachable. Large folders get a type-to-
 * filter box and an A–Z jump rail; the folder-vs-file distinction stays clear from
 * each row's pink-folder / blue-book icon.
 *
 * Scopes to the route's OWN `?connection=` (local param, reliable on a cold deep link);
 * the body consumes it via `useScopedCid()`, so it's a child of `<ContentScope>`.
 */
export function BrowseScreen() {
  return (
    <ContentScope>
      <BrowseContent />
    </ContentScope>
  );
}

function BrowseContent() {
  const { t } = useTranslation();
  const { libraryId: libraryIdParam, path: pathParam } = useLocalSearchParams<{
    libraryId: string;
    path?: string | string[];
  }>();
  const libraryId = Number(libraryIdParam);
  const path = segmentsToPath(pathParam);
  // The connection rides in the `?connection=` query param; the `(app)` layout publishes
  // it as the scope, so browse/scroll/hrefs all resolve to that server (not the default).
  const cid = useScopedCid();

  const { data: libraries } = useLibraries();
  const { data, isLoading, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useBrowseInfinite(libraryId, path);
  const paddingBottom = useMiniPlayerInset();

  const [query, setQuery] = useState('');

  // This screen unmounts on every navigation (see scroll-memory); restore the
  // last position ourselves. We remember the top visible row index rather than a
  // pixel offset, which is reliable on a virtualized list.
  const listRef = useRef<FlatList<Row>>(null);
  const restoredRef = useRef(false);
  const key = scrollKey(cid, libraryId, path);
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
  }, [key]);

  // Pull every page so the filter + rail operate on the complete folder.
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const entries = useMemo(() => data?.pages.flatMap((p) => p.entries) ?? [], [data]);
  const total = data?.pages[0]?.total ?? entries.length;
  const showTools = total > NARROW_THRESHOLD;

  const sections = useMemo(
    () => groupByLetter(filterEntries(entries, showTools ? query : '')),
    [entries, query, showTools],
  );
  const present = useMemo(() => presentLetters(sections), [sections]);

  // Flatten sections into rows; record each section's header row index (the A–Z
  // rail's scroll target) and the cumulative pixel offset of every row (so
  // getItemLayout - and thus the rail jump - is exact).
  const { rows, headerRows, offsets } = useMemo(() => {
    const rows: Row[] = [];
    const headerRows: number[] = [];
    const offsets: number[] = [];
    let y = 0;
    for (const s of sections) {
      headerRows.push(rows.length);
      offsets.push(y);
      rows.push({ type: 'header', letter: s.letter });
      y += HEADER_H;
      for (const e of s.data) {
        offsets.push(y);
        rows.push({ type: 'entry', entry: e });
        y += ENTRY_H;
      }
    }
    return { rows, headerRows, offsets };
  }, [sections]);

  const getItemLayout = (_: ArrayLike<Row> | null | undefined, index: number) => ({
    length: rows[index]?.type === 'header' ? HEADER_H : ENTRY_H,
    offset: offsets[index] ?? 0,
    index,
  });

  const libraryName =
    libraries?.find((l) => l.id === libraryId)?.name ?? t('library.browse.fallbackName');
  const segments = path ? path.split('/') : [];
  const crumbs: Crumb[] = [
    {
      label: libraryName,
      active: segments.length === 0,
      onPress: segments.length === 0 ? undefined : () => router.push(libraryHref(cid, libraryId)),
    },
    ...segments.map((seg, i) => {
      const isLast = i === segments.length - 1;
      const sub = segments.slice(0, i + 1).join('/');
      return {
        label: seg,
        active: isLast,
        onPress: isLast ? undefined : () => router.push(libraryHref(cid, libraryId, sub)),
      } satisfies Crumb;
    }),
  ];

  const onViewableItemsChanged = useCallback((info: { viewableItems: ViewToken[] }) => {
    const idxs = info.viewableItems.map((v) => v.index).filter((i): i is number => i != null);
    if (idxs.length) rememberScroll(keyRef.current, Math.min(...idxs));
  }, []);

  // Re-apply the saved row index once the list has rows to scroll to.
  useEffect(() => {
    if (restoredRef.current || rows.length === 0) return;
    restoredRef.current = true;
    const saved = recallScroll(key);
    if (saved > 0) {
      const offset = offsets[Math.min(saved, rows.length - 1)] ?? 0;
      requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset, animated: false }));
    }
  }, [rows.length, key, offsets]);

  const jumpToLetter = (letter: string) => {
    const sectionIdx = sectionIndexForLetter(sections, letter);
    if (sectionIdx < 0) return;
    const offset = offsets[headerRows[sectionIdx]];
    if (offset == null) return;
    listRef.current?.scrollToOffset({ offset, animated: false });
  };

  const renderItem: ListRenderItem<Row> = ({ item }) =>
    item.type === 'header' ? (
      // Background matches the page (gray-200/gray-800) so the sticky header
      // occludes scrolled rows without showing as a distinct block.
      <View
        style={{ height: HEADER_H }}
        className="justify-end bg-gray-200 px-4 pb-2 dark:bg-gray-800 lg:px-8"
      >
        <Text variant="label">{item.letter}</Text>
      </View>
    ) : (
      <View style={{ height: ENTRY_H }} className="px-4 lg:px-8">
        <EntryRow entry={item.entry} connectionId={cid} libraryId={libraryId} />
      </View>
    );

  const emptyMessage =
    showTools && query.trim().length > 0
      ? t('library.browse.noMatches')
      : t('library.browse.empty');

  return (
    <View className="flex-1">
      {crumbs.length > 1 || showTools ? (
        <View className="px-4 pt-4 lg:px-8">
          {crumbs.length > 1 ? <BreadCrumbs crumbs={crumbs} /> : null}
          {showTools ? (
            <TextField
              containerClassName={crumbs.length > 1 ? 'mt-3' : ''}
              placeholder={t('library.browse.filterPlaceholder')}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
          ) : null}
        </View>
      ) : null}

      {isLoading ? <Spinner center /> : null}
      {error ? (
        <ErrorNote message={t('library.browse.openError')} onRetry={() => refetch()} />
      ) : null}

      {!isLoading && !error ? (
        <View className="flex-1 flex-row">
          <FlatList
            ref={listRef}
            className="flex-1"
            data={rows}
            keyExtractor={(item) => (item.type === 'header' ? `#${item.letter}` : item.entry.path)}
            renderItem={renderItem}
            getItemLayout={getItemLayout}
            stickyHeaderIndices={headerRows}
            contentContainerStyle={{ paddingBottom }}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={VIEWABILITY_CONFIG}
            ListEmptyComponent={
              <View className="px-4 lg:px-8">
                <EmptyNote message={emptyMessage} />
              </View>
            }
            ListFooterComponent={
              isFetchingNextPage ? (
                <View className="py-4">
                  <Spinner center />
                </View>
              ) : null
            }
          />

          {showTools && present.size > 1 ? (
            // Inset the rail so its 27 letters distribute (each flex-1) within the
            // column instead of overflowing: a top gap clears the filter box, and
            // the same bottom inset the list uses keeps the last letters above the
            // floating mini-player. pr-3 lifts it off the screen edge.
            <View style={{ paddingTop: 12, paddingBottom }} className="w-10 items-center pr-3">
              {RAIL_LETTERS.map((l) => {
                const active = present.has(l);
                return (
                  <Pressable
                    key={l}
                    disabled={!active}
                    onPress={() => jumpToLetter(l)}
                    hitSlop={{ top: 2, bottom: 2, left: 12, right: 6 }}
                    accessibilityRole="button"
                    accessibilityLabel={t('library.browse.jumpTo', { letter: l })}
                    className="w-full flex-1 items-center justify-center"
                  >
                    <Text
                      className={`text-[10px] font-roboto-semibold ${
                        active ? 'text-primary' : 'text-gray-300 dark:text-gray-700'
                      }`}
                    >
                      {l}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
