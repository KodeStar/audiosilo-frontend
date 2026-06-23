import { router, useLocalSearchParams } from 'expo-router';
import { type ReactElement, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Pressable, useWindowDimensions, View } from 'react-native';

import { useAllProgressAll, useRecentAll, type MergedBook } from '@/api/hooks';
import { GRID_GAP, GridCard, gridColumns } from '@/components/library/poster-grid';
import { ProgressCard, progressKey } from '@/components/library/progress-card';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { EmptyNote, ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { formatRelative } from '@/lib/format';
import { pathLeaf } from '@/lib/paths';

const WIDE_BREAKPOINT = 1024;
// How many of each type to load on this page (the home shelves show 15).
const PAGE_LIMIT = 200;

type BrowseType = 'recent' | 'finished';

const TYPES: { key: BrowseType; labelKey: 'recentlyAdded' | 'recentlyFinished' }[] = [
  { key: 'recent', labelKey: 'recentlyAdded' },
  { key: 'finished', labelKey: 'recentlyFinished' },
];

const bookKey = (b: MergedBook) => `${b.connectionId}:${b.library_id}:${b.rel_path}`;

/** Two-way selector to switch the list type, kept in sync with the URL param. */
function TypeSelector({
  value,
  onChange,
}: {
  value: BrowseType;
  onChange: (t: BrowseType) => void;
}) {
  const { t } = useTranslation();
  return (
    <View className="flex-row self-start rounded-xl bg-gray-100 p-1 dark:bg-gray-840">
      {TYPES.map((o) => {
        const active = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            className={`rounded-lg px-4 py-2 ${active ? 'bg-primary' : ''}`}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text
              className={`font-roboto-medium ${
                active ? 'text-white dark:text-white' : 'text-gray-600 dark:text-gray-300'
              }`}
            >
              {t(`library.list.${o.labelKey}`)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function BrowseScreen() {
  const { t } = useTranslation();
  // The active type is driven by the URL param, so a fresh "View more" tap (which
  // updates the param) switches the list without any mirrored state.
  const params = useLocalSearchParams<{ type?: string }>();
  const type: BrowseType = params.type === 'finished' ? 'finished' : 'recent';
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;
  const paddingBottom = useMiniPlayerInset();

  const { books: recent, isLoading: recentLoading, error: recentError } = useRecentAll(PAGE_LIMIT);
  const { progress, isLoading: progressLoading, error: progressError } = useAllProgressAll();
  const finished = useMemo(
    () =>
      progress.filter((p) => p.finished).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [progress],
  );

  // Measure the list area so columns track the available width (sidebar on desktop).
  const [gridWidth, setGridWidth] = useState(0);
  const pad = wide ? 32 : 16;
  const inner = Math.max(0, gridWidth - pad * 2);
  const columns = gridColumns(inner);
  const cardWidth = inner > 0 ? Math.floor((inner - GRID_GAP * (columns - 1)) / columns) : 0;

  const recentCard = (b: MergedBook, w: number): ReactElement => {
    const added = formatRelative(b.added_at);
    return (
      <GridCard
        libraryId={b.library_id}
        path={b.rel_path}
        title={b.title || pathLeaf(b.rel_path)}
        author={b.author}
        connectionId={b.connectionId}
        width={w}
        footer={
          added ? (
            <Text variant="caption">{t('library.list.added', { when: added })}</Text>
          ) : undefined
        }
      />
    );
  };

  const onChange = (t: BrowseType) => router.setParams({ type: t });

  const loading = type === 'recent' ? recentLoading : progressLoading;
  const error = type === 'recent' ? recentError : progressError;
  const isEmpty = type === 'recent' ? recent.length === 0 : finished.length === 0;

  const empty = loading ? (
    <Spinner center />
  ) : error && isEmpty ? (
    <ErrorNote message={t('library.list.loadError')} />
  ) : (
    <EmptyNote
      message={type === 'recent' ? t('library.list.noBooks') : t('library.list.noFinished')}
    />
  );

  return (
    <View className="flex-1">
      <View className="p-4 lg:px-8">
        <TypeSelector value={type} onChange={onChange} />
      </View>
      <View className="flex-1" onLayout={(e) => setGridWidth(e.nativeEvent.layout.width)}>
        {gridWidth === 0 ? (
          <Spinner center />
        ) : type === 'recent' ? (
          <FlatList
            key={`recent-${columns}`}
            data={recent}
            numColumns={columns}
            keyExtractor={bookKey}
            columnWrapperStyle={columns > 1 ? { gap: GRID_GAP } : undefined}
            renderItem={({ item }) => (
              <View style={{ width: cardWidth }}>{recentCard(item, cardWidth)}</View>
            )}
            contentContainerClassName="p-4 lg:px-8"
            contentContainerStyle={{ gap: GRID_GAP, paddingBottom }}
            ListEmptyComponent={empty}
          />
        ) : (
          <FlatList
            key={`finished-${columns}`}
            data={finished}
            numColumns={columns}
            keyExtractor={progressKey}
            columnWrapperStyle={columns > 1 ? { gap: GRID_GAP } : undefined}
            renderItem={({ item }) => (
              <View style={{ width: cardWidth }}>
                <ProgressCard item={item} width={cardWidth} />
              </View>
            )}
            contentContainerClassName="p-4 lg:px-8"
            contentContainerStyle={{ gap: GRID_GAP, paddingBottom }}
            ListEmptyComponent={empty}
          />
        )}
      </View>
    </View>
  );
}
