import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';

import {
  useAuthors,
  useCapability,
  useCollections,
  useNarrators,
  useSeriesList,
} from '@/api/hooks';
import { type LibraryMode, libraryModeHref } from '@/components/library/library-modes';
import { useSelectedLibrary } from '@/components/library/use-selected-library';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon, type IconName } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { FOCUS_RING_CLASS, FOCUS_RING_OFFSET_CLASS, Text } from '@/components/ui/text';
import { formatCount } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { useRecentSearches } from '@/stores/search';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

type BrowseCard = {
  mode: LibraryMode;
  labelKey:
    | 'library.modes.authors'
    | 'library.modes.series'
    | 'library.modes.narrators'
    | 'library.modes.collections';
  icon: IconName;
  /** undefined while loading. */
  count: number | undefined;
};

/**
 * Search before anything is typed: the recent searches (the list the web palette
 * shares) and the Browse cards, which open the Library's modes for the selected library
 * with its counts. A card shows only once its server is known to support the mode. With
 * neither (a first visit to an older server), a one-line prompt.
 */
export function SearchIdle({ onPick }: { onPick: (query: string) => void }) {
  const { t } = useTranslation();
  const recent = useRecentSearches((s) => s.recent);
  const clear = useRecentSearches((s) => s.clear);
  const { cards, known } = useBrowseCards();
  const { library, groups } = useSelectedLibrary();
  const manyLibraries = groups.reduce((n, g) => n + g.libraries.length, 0) > 1;

  if (recent.length === 0 && cards.length === 0) {
    // Nothing yet while the server's capabilities are on their way (no flash).
    if (!known) return null;
    return <EmptyState icon="search" title={t('search.promptTitle')} hint={t('search.prompt')} />;
  }
  return (
    <View className="gap-7 pt-2">
      {recent.length > 0 ? (
        <View className="gap-2.5">
          <View className="flex-row items-center justify-between">
            <Text variant="eyebrow">{t('search.recentTitle')}</Text>
            <Pressable
              onPress={clear}
              accessibilityRole="button"
              accessibilityLabel={t('search.clearRecentLabel')}
              hitSlop={10}
              className={cn(
                'rounded-control px-2 py-1 active:bg-accent',
                Platform.select({
                  web: `cursor-pointer hover:bg-accent ${FOCUS_RING_CLASS}`,
                }),
              )}
            >
              <Text variant="caption">{t('search.clearRecent')}</Text>
            </Pressable>
          </View>
          <View className="flex-row flex-wrap gap-2">
            {recent.map((r) => (
              <RecentChip key={r} label={r} onPress={() => onPick(r)} />
            ))}
          </View>
        </View>
      ) : null}
      {cards.length > 0 ? (
        <View className="gap-2.5">
          <View className="flex-row items-baseline gap-2">
            <Text variant="eyebrow">{t('search.browse')}</Text>
            {manyLibraries && library ? (
              <Text variant="caption" numberOfLines={1} className="shrink">
                {t('search.browseIn', { library: library.name })}
              </Text>
            ) : null}
          </View>
          <BrowseGrid cards={cards} />
        </View>
      ) : null}
    </View>
  );
}

/** A recent search: a 32-tall pill with the history glyph; tapping searches it again. */
function RecentChip({ label, onPress }: { label: string; onPress: () => void }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('search.searchAgain', { query: label })}
      hitSlop={{ top: 6, bottom: 6 }}
      className={cn(
        'h-8 max-w-full flex-row items-center gap-1.5 rounded-full border border-border-strong bg-card px-3 active:bg-accent',
        Platform.select({
          web: `cursor-pointer hover:bg-accent ${FOCUS_RING_OFFSET_CLASS}`,
        }),
      )}
    >
      <Icon name="history" size={14} color={themed.foreground} />
      <Text className="shrink font-sans-semibold text-[13px] text-foreground" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Four across on tablet and desktop, two on a phone. */
function BrowseGrid({ cards }: { cards: BrowseCard[] }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const phone = useLayout() === 'phone';
  return (
    <View className="flex-row flex-wrap gap-3">
      {cards.map((c) => {
        const label = t(c.labelKey);
        return (
          <Pressable
            key={c.mode}
            onPress={() => router.navigate(libraryModeHref(c.mode))}
            accessibilityRole="button"
            accessibilityLabel={
              c.count === undefined ? label : t('search.browseCard', { label, count: c.count })
            }
            style={{ flexBasis: phone ? '45%' : '22%' }}
            className={cn(
              'min-h-[72px] grow flex-row items-center gap-3 rounded-card border border-border bg-card p-4 active:bg-accent',
              Platform.select({
                web: `cursor-pointer transition-colors hover:bg-accent ${FOCUS_RING_OFFSET_CLASS}`,
              }),
            )}
          >
            <View className="h-9 w-9 items-center justify-center rounded-control bg-muted">
              <Icon name={c.icon} size={17} color={themed.mutedForeground} />
            </View>
            <View className="min-w-0 flex-1 gap-0.5">
              <Text variant="label" numberOfLines={1}>
                {label}
              </Text>
              {c.count === undefined ? (
                <Skeleton className="h-3 w-10 rounded-sm" />
              ) : (
                <Text variant="caption" style={tabularNums}>
                  {formatCount(c.count)}
                </Text>
              )}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The cards the selected library's server supports, with that library's counts;
 * `known` once its capabilities (or the lack of any library) are known. */
function useBrowseCards(): { cards: BrowseCard[]; known: boolean } {
  const { selection, isLoading } = useSelectedLibrary();
  const cid = selection?.connectionId ?? '';
  const lib = selection?.libraryId ?? 0;
  const peopleFlag = useCapability('browse_people', cid);
  const collectionsFlag = useCapability('collections', cid);
  const people = peopleFlag === true;
  const collectionsOn = collectionsFlag === true;
  const authors = useAuthors(lib, cid).data;
  const series = useSeriesList(lib, cid).data;
  const narrators = useNarrators(lib, cid).data;
  const collections = useCollections(cid).data;
  if (!selection) return { cards: [], known: !isLoading };
  const cards: BrowseCard[] = [];
  if (people) {
    cards.push(
      {
        mode: 'authors',
        labelKey: 'library.modes.authors',
        icon: 'user',
        count: authors?.people.length,
      },
      { mode: 'series', labelKey: 'library.modes.series', icon: 'layers', count: series?.length },
      {
        mode: 'narrators',
        labelKey: 'library.modes.narrators',
        icon: 'microphone',
        count: narrators?.people.length,
      },
    );
  }
  if (collectionsOn) {
    cards.push({
      mode: 'collections',
      labelKey: 'library.modes.collections',
      icon: 'bookmark',
      count: collections?.length,
    });
  }
  return { cards, known: peopleFlag !== undefined && collectionsFlag !== undefined };
}
