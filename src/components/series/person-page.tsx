import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';

import { useAllLibraryBooks, useCapability, useProgressLookup } from '@/api/hooks';
import { useCid } from '@/api/provider';
import type { Book } from '@/api/types';
import { CoverGrid, CoverGridSkeleton } from '@/components/library/cover-grid';
import { CoverTile } from '@/components/library/cover-tile';
import { ShelfRow } from '@/components/library/shelf-row';
import { Icon, type IconName } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { formatDuration, formatDurationOrZero } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { EmptyShelf } from './empty-shelf';
import { booksBySeries, creditedPeople, personStats } from './people-model';
import type { PersonKind } from './people-mode';
import { PersonChip } from './person-chip';
import { Portrait } from './portrait';
import { type ProgressLookup, yearOf } from './series-model';

/** A tile's caption on these pages: "2004 · 12h 20m". */
function bookCaption(b: Book): string {
  return [yearOf(b.published), formatDuration(b.duration)].filter(Boolean).join(' · ');
}

/**
 * An author or narrator page (`/author`, `/narrator`): their portrait, name and numbers
 * (books here, total length, finished, listened), their books grouped by series (a shelf
 * each; the series name opens the series page) then the books in no series as a grid,
 * and the other people credited on them as chips ("Read by" narrators on an author page,
 * "Books by" authors on a narrator page). `name` is the exact field value. A narrator
 * page needs `browse_people` (an older server would ignore the filter and list the whole
 * library), so it says so instead.
 */
export function PersonPage({
  kind,
  libraryId,
  name,
}: {
  kind: PersonKind;
  libraryId: number;
  name: string;
}) {
  const { t } = useTranslation();
  const cid = useCid();
  const { openAuthor, openNarrator } = useOpen();
  const browse = useCapability('browse_people');
  const { progressOf } = useProgressLookup();
  const q = useAllLibraryBooks(
    libraryId,
    kind === 'author' ? { author: name } : { narrator: name },
  );

  if (kind === 'narrator' && browse === false) {
    return (
      <EmptyShelf
        title={t('people.narratorUnsupported')}
        hint={t('people.narratorUnsupportedHint')}
      />
    );
  }
  if (q.isLoading || q.isIdle) return <PersonSkeleton kind={kind} />;
  if (q.error && q.books.length === 0) {
    return (
      <EmptyShelf
        title={t('people.pageError')}
        hint={t('series.error.hint')}
        action={{ label: t('common.retry'), icon: 'rotate', onPress: q.retry }}
      />
    );
  }
  if (q.books.length === 0) {
    return <EmptyShelf title={t('people.pageEmpty', { name })} hint={t('people.pageEmptyHint')} />;
  }

  const { series, standalone } = booksBySeries(q.books);
  const others = creditedPeople(q.books, kind === 'author' ? 'narrator' : 'author', name);
  // A narrator page needs the narrator filter, so an author's "Read by" chips wait for it.
  const chips = kind === 'narrator' || browse === true ? others : [];

  const header = (
    <View className="gap-8 pb-2 pt-4">
      <PersonHeader kind={kind} name={name} books={q.books} progressOf={progressOf} />
      {series.map((g) => (
        <SeriesShelf key={g.series} series={g.series} books={g.books} libraryId={libraryId} />
      ))}
      {standalone.length > 0 ? (
        <Text variant="heading" accessibilityRole="header">
          {series.length > 0 ? t('people.otherBooks') : t('people.books')}
        </Text>
      ) : null}
    </View>
  );

  return (
    <CoverGrid
      data={standalone}
      keyExtractor={(b) => b.rel_path}
      renderItem={(b, width) => (
        <CoverTile
          connectionId={cid}
          libraryId={b.library_id}
          path={b.rel_path}
          title={b.title}
          caption={kind === 'narrator' ? b.author : bookCaption(b)}
          book={b}
          author={b.author}
          coverVersion={b.cover_version}
          width={width}
        />
      )}
      ListHeaderComponent={header}
      ListFooterComponent={
        chips.length > 0 ? (
          <View className="gap-3 pb-6 pt-2">
            <Text variant="heading" accessibilityRole="header">
              {kind === 'author' ? t('people.readBy') : t('people.booksBy')}
            </Text>
            <View className="flex-row flex-wrap gap-2.5">
              {chips.map((p) => (
                <PersonChip
                  key={p.name}
                  name={p.name}
                  kind={kind === 'author' ? 'narrator' : 'author'}
                  onPress={() =>
                    (kind === 'author' ? openNarrator : openAuthor)(cid, libraryId, p.name)
                  }
                />
              ))}
            </View>
          </View>
        ) : null
      }
    />
  );
}

function PersonHeader({
  kind,
  name,
  books,
  progressOf,
}: {
  kind: PersonKind;
  name: string;
  books: Book[];
  progressOf: ProgressLookup;
}) {
  const { t } = useTranslation();
  const cid = useCid();
  const phone = useLayout() === 'phone';
  const s = personStats(books, cid, progressOf);
  const tiles: { icon: IconName; label: string; value: string }[] = [
    { icon: 'book', label: t('people.stats.books'), value: String(s.books) },
    { icon: 'clock', label: t('people.stats.length'), value: formatDurationOrZero(s.seconds) },
    { icon: 'circle-check', label: t('people.stats.finished'), value: String(s.finished) },
    {
      icon: 'history',
      label: t('people.stats.listened'),
      value: formatDurationOrZero(s.listened),
    },
  ];
  return (
    <View className="gap-6">
      <View className="flex-row flex-wrap items-center gap-x-7 gap-y-4">
        <Portrait name={name} kind={kind} size={phone ? 96 : 140} />
        <View className="min-w-0 flex-1 gap-2">
          <Text variant="eyebrow">
            {kind === 'author' ? t('people.author') : t('people.narrator')}
          </Text>
          <Text
            variant="display"
            accessibilityRole="header"
            className={phone ? undefined : 'text-[44px] leading-[46px]'}
          >
            {name}
          </Text>
        </View>
      </View>
      <View className="flex-row flex-wrap gap-3">
        {tiles.map((tile) => (
          <StatTile key={tile.label} {...tile} />
        ))}
      </View>
    </View>
  );
}

function StatTile({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  const themed = useThemeColors();
  return (
    <View
      className="min-w-[140px] flex-1 basis-[40%] gap-2 rounded-card border border-border bg-card p-4 md:basis-0"
      accessible
      accessibilityLabel={`${label}: ${value}`}
    >
      <View className="flex-row items-center gap-1.5">
        <Icon name={icon} size={14} color={themed.mutedForeground} />
        <Text variant="caption">{label}</Text>
      </View>
      <Text variant="stat">{value}</Text>
    </View>
  );
}

/** One of the person's series: its name (opening the series page) over a shelf of its
 * books in series order. */
function SeriesShelf({
  series,
  books,
  libraryId,
}: {
  series: string;
  books: Book[];
  libraryId: number;
}) {
  const { t } = useTranslation();
  const cid = useCid();
  const themed = useThemeColors();
  const { openSeries } = useOpen();
  return (
    <View className="gap-3">
      <Pressable
        onPress={() => openSeries(cid, libraryId, { name: series })}
        accessibilityRole="link"
        accessibilityLabel={t('people.openSeries', { series })}
        hitSlop={8}
        className={cn(
          'flex-row items-center gap-1.5 self-start rounded-md active:opacity-70',
          Platform.select({
            web: `cursor-pointer ${FOCUS_RING_CLASS}`,
          }),
        )}
      >
        <Text variant="heading">{series}</Text>
        <Icon name="chevron-right" size={18} color={themed.mutedForeground} />
      </Pressable>
      <ShelfRow
        data={books}
        keyExtractor={(b) => b.rel_path}
        accessibilityLabel={series}
        renderItem={(b, width) => (
          <CoverTile
            onShelf
            connectionId={cid}
            libraryId={b.library_id}
            path={b.rel_path}
            title={b.title}
            book={b}
            caption={[
              b.series_index > 0 ? t('series.bookN', { position: b.series_index }) : '',
              yearOf(b.published),
            ]
              .filter(Boolean)
              .join(' · ')}
            author={b.author}
            coverVersion={b.cover_version}
            width={width}
          />
        )}
      />
    </View>
  );
}

function PersonSkeleton({ kind }: { kind: PersonKind }) {
  const phone = useLayout() === 'phone';
  const size = phone ? 96 : 140;
  return (
    <View
      className="gap-6 pt-4"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View className="flex-row items-center gap-7 px-4 lg:px-8">
        <View style={{ width: size, height: size }}>
          <Skeleton
            className={cn('h-full w-full', kind === 'author' ? 'rounded-full' : 'rounded-3xl')}
          />
        </View>
        <View className="flex-1 gap-2">
          <Skeleton className="h-3 w-24 rounded-sm" />
          <Skeleton className="h-9 w-2/3 rounded-md" />
        </View>
      </View>
      <CoverGridSkeleton rows={2} />
    </View>
  );
}
