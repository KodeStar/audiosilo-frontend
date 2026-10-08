import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';

import {
  useAllLibraryBooks,
  useBookMeta,
  useCapability,
  useMetaWork,
  useProgressLookup,
} from '@/api/hooks';
import { useCid } from '@/api/provider';
import type { BookRef } from '@/api/types';
import { CoverWash } from '@/components/library/cover-wash';
import { GhostCover } from '@/components/library/ghost-cover';
import { SourceLine } from '@/components/library/source-line';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { Button } from '@/components/ui/button';
import { SectionHeader } from '@/components/ui/section-header';
import { RowSkeletonList, Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { SegmentedControl } from '@/components/ui/toggle-group';
import { contentKey } from '@/lib/content-key';
import { formatDuration } from '@/lib/format';
import { CONTENT_WIDTH, useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { percentOf } from '@/lib/progress-view';
import {
  familyKey,
  familyName,
  orderingLabelKey,
  selectedView,
  seriesViews,
} from '@/lib/series-orderings';
import { openExternalUrl } from '@/lib/support';
import { cn } from '@/lib/utils';
import { useSeriesOrderings } from '@/stores/series-orderings';
import { useConnectionName } from '@/stores/session';

import { Bookcase, bookcaseScale } from './bookcase';
import { EmptyShelf } from './empty-shelf';
import { KeepAheadCard } from './keep-ahead-card';
import {
  currentEntry,
  defaultSelection,
  localEntries,
  looseKey,
  metadataAnchor,
  pickRail,
  railEntries,
  seriesStats,
  trackSegments,
  typicalSeconds,
} from './series-model';
import { EntryList, ProgressTrack, ShelfCaption, ShelfLegend, statsLine } from './series-parts';
import { spineDims } from './spine-fit';
import { useResumeChapter } from './use-resume-chapter';
import { useElsewhereBooks, usePlacedBooks } from './use-series-data';

const ORDER_NOTE_KEY = {
  publication: 'series.orderNote.publication',
  chronological: 'series.orderNote.chronological',
  recommended: 'series.orderNote.recommended',
} as const;

const LIST_TITLE_KEY = {
  publication: 'series.listTitle.publication',
  chronological: 'series.listTitle.chronological',
  recommended: 'series.listTitle.recommended',
} as const;

/**
 * The series page for a LOCAL series (`name`, the exact `Book.series`), optionally
 * pinned to a community work (`work`): the listener's books in the series, and - when
 * the server has community metadata and matches one of them - the whole series in the
 * chosen reading order, gaps included (STYLEGUIDE section 8, "Series shelf").
 *
 * Data: the owned books (`useAllLibraryBooks`, the `series=` filter), the saved progress
 * on every connection, the community rails of ONE owned book (`useBookMeta` on the book
 * you're on, else the first with an ASIN/ISBN: the server matches by those), the books
 * of the series on the other connections (one search each), and the rows of books the
 * rail places in other libraries. Without `metadata`, or with no match, the page is the
 * local series with "Book N" ghosts for the gaps. Spoilers: titles and positions only,
 * no recaps or characters.
 */
export function SeriesPage({
  libraryId,
  name,
  work,
}: {
  libraryId: number;
  name: string;
  work?: string;
}) {
  const { t } = useTranslation();
  const layout = useLayout();
  const cid = useCid();
  const here = useConnectionName(cid);
  const paddingBottom = useMiniPlayerInset();
  const { progressOf, loadingOf } = useProgressLookup();
  // The anchor and the rail wait below read only THIS server's progress: another server
  // that is slow or unreachable must not hold the page on its skeleton.
  const progressLoading = loadingOf(cid);
  const owned = useAllLibraryBooks(libraryId, { series: name });
  const metadata = useCapability('metadata');
  // Wait for the progress so the anchor is the book you're on, not one asked for first
  // and replaced a moment later.
  const anchor =
    owned.complete && !progressLoading ? metadataAnchor(owned.books, cid, progressOf) : undefined;
  const meta = useBookMeta(
    anchor?.library_id ?? libraryId,
    anchor?.rel_path ?? '',
    metadata === true && !!anchor,
  );
  const ownedKeys = useMemo(
    () => new Set(owned.books.map((b) => contentKey(cid, b.library_id, b.rel_path))),
    [owned.books, cid],
  );
  const rail = pickRail(meta.data?.matched ? meta.data.series : undefined, {
    name,
    workId: work,
    connectionId: cid,
    ownedKeys,
  });
  const picks = useSeriesOrderings((s) => s.picks);
  const pickOrder = useSeriesOrderings((s) => s.pick);
  const views = rail ? seriesViews(rail) : [];
  const view = rail ? selectedView(rail, picks, views) : undefined;
  const placedRefs: BookRef[] = (view?.works ?? []).flatMap((w) =>
    w.local && !ownedKeys.has(contentKey(cid, w.local.library_id, w.local.path)) ? [w.local] : [],
  );
  const placed = usePlacedBooks(cid, placedRefs);
  const elsewhere = useElsewhereBooks(cid, rail ? familyName(rail, views) : name);

  const source = { connectionId: cid, connectionName: here, progressOf };
  const entries = view
    ? railEntries(view, owned.books, { ...source, elsewhere, extraBooks: placed })
    : localEntries(owned.books, {
        ...source,
        elsewhere: elsewhere.filter((b) => looseKey(b.series) === looseKey(name)),
      });

  const [picked, setPicked] = useState<string>();
  // Set in the same render as a new reading order, so the bookcase slides its spines.
  const [sliding, setSliding] = useState(false);
  useEffect(() => {
    if (!sliding) return;
    const timer = setTimeout(() => setSliding(false), 700);
    return () => clearTimeout(timer);
  }, [sliding]);
  const selected = entries.find((e) => e.key === picked) ?? defaultSelection(entries);
  const current = currentEntry(entries);
  const resumeChapter = useResumeChapter(
    current?.copy,
    current?.copy
      ? progressOf(current.copy.connectionId, current.copy.libraryId, current.copy.path)?.position
      : undefined,
  );

  // With community metadata on, the page waits for the rail before it lays out: a local
  // series ("6 entries") that then reflowed into the whole one (17) jumped on a deep link.
  // A failed or unmatched lookup falls back to the local series.
  const railPending =
    metadata === true &&
    ((!owned.complete && !owned.error) || progressLoading || (!!anchor && meta.isLoading));
  if (owned.isLoading || railPending) return <SeriesSkeleton />;
  if (owned.error && owned.books.length === 0) {
    return (
      <EmptyShelf
        title={t('series.error.title')}
        hint={t('series.error.hint')}
        action={{ label: t('common.retry'), icon: 'rotate', onPress: () => owned.retry() }}
      />
    );
  }
  if (entries.length === 0) {
    return <EmptyShelf title={t('series.empty.title')} hint={t('series.empty.hint', { name })} />;
  }

  const stats = seriesStats(entries);
  const typical = typicalSeconds(entries);
  const wash =
    selected?.coverColor ?? current?.coverColor ?? entries.find((e) => e.coverColor)?.coverColor;
  const author = owned.books.find((b) => b.author)?.author;
  const progressLabel = [
    current
      ? current.position
        ? t('series.progress.into', {
            percent: percentOf(current.fraction),
            position: current.position,
          })
        : t('series.progress.intoTitle', {
            percent: percentOf(current.fraction),
            title: current.title,
          })
      : t('series.progress.finished', { finished: stats.finished, total: stats.entries }),
    stats.aheadSeconds > 0
      ? t('series.progress.ahead', { duration: formatDuration(stats.aheadSeconds) })
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const orderKey = view?.ordering;
  const listTitleKey = orderKey ? LIST_TITLE_KEY[orderKey] : undefined;
  const gutter = 'px-4 lg:px-8';

  return (
    <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom }}>
      <View className="relative overflow-hidden border-b border-border">
        <CoverWash color={wash} variant="hero" />
        <View className={cn(CONTENT_WIDTH, 'self-center pt-5 lg:pt-7')}>
          <View className={cn(gutter, 'gap-2.5')}>
            <SeriesEyebrow libraryId={libraryId} author={author} />
            <Text
              variant="display-xl"
              accessibilityRole="header"
              className={layout === 'desktop' ? 'text-5xl leading-[52px]' : undefined}
            >
              {name}
            </Text>
            <View className="flex-row flex-wrap gap-x-[18px] gap-y-1">
              {statsLine(stats, t).map((s) => (
                <Text key={s} variant="muted">
                  {s}
                </Text>
              ))}
            </View>
            <View className="mt-2">
              <ProgressTrack segments={trackSegments(entries)} label={progressLabel} />
            </View>
            {rail && view ? (
              <View className="mt-2 flex-row flex-wrap items-center justify-between gap-2.5">
                {views.length > 1 ? (
                  <SegmentedControl
                    scrollable
                    options={views.map((v) => {
                      const key = orderingLabelKey(v.ordering);
                      return { value: v.id, label: key ? t(key) : v.name };
                    })}
                    value={view.id}
                    onChange={(id) => {
                      setSliding(true);
                      pickOrder(familyKey(rail), id);
                    }}
                    accessibilityLabel={t('series.readingOrder')}
                    className="max-w-full self-start"
                  />
                ) : null}
                {orderKey ? (
                  <Text variant="muted" className="shrink">
                    {t(ORDER_NOTE_KEY[orderKey])}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
          <View className="mt-3">
            <Bookcase
              entries={entries}
              selectedKey={selected?.key}
              currentKey={current?.key}
              onSelect={setPicked}
              layout={layout}
              typicalSeconds={typical}
              slide={sliding}
              accessibilityLabel={t('series.shelfLabel', { series: name })}
            />
          </View>
          <View className={gutter}>
            {selected ? (
              <ShelfCaption
                key={selected.key}
                entry={selected}
                current={selected.key === current?.key}
                here={here}
                resumeChapter={resumeChapter}
              />
            ) : null}
            <ShelfLegend entries={entries} hasCurrent={!!current} />
          </View>
        </View>
      </View>
      <View className={cn(CONTENT_WIDTH, gutter, 'self-center pt-7')}>
        <View className="w-full max-w-[880px] gap-2">
          <View className="flex-row items-baseline gap-2.5">
            <SectionHeader
              title={t(listTitleKey ?? 'series.listTitle.default')}
              className="shrink"
            />
            <Text variant="caption">{t('series.stats.entries', { count: entries.length })}</Text>
          </View>
          <EntryList entries={entries} currentKey={current?.key} />
          <KeepAheadCard />
          {rail ? <SourceLine label={t('series.source')} className="mt-3" /> : null}
        </View>
      </View>
    </ScrollView>
  );
}

/** "SERIES · Jim Butcher", the author opening their page. */
function SeriesEyebrow({ libraryId, author }: { libraryId: number; author?: string }) {
  const { t } = useTranslation();
  const cid = useCid();
  const { openAuthor } = useOpen();
  return (
    <View className="flex-row flex-wrap items-center gap-1">
      <Text variant="eyebrow">{t('series.eyebrow')}</Text>
      {author ? (
        <>
          <Text variant="eyebrow">·</Text>
          <Pressable
            onPress={() => openAuthor(cid, libraryId, author)}
            accessibilityRole="link"
            hitSlop={8}
            className="rounded-sm active:opacity-70"
          >
            <Text variant="eyebrow" className="text-foreground underline">
              {author}
            </Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

/** The page while the series' books load: the hero's lines, a shelf of spine-shaped
 * placeholders on the plank and list rows, at their real sizes. */
function SeriesSkeleton() {
  const layout = useLayout();
  const scale = bookcaseScale(layout);
  return (
    <View
      className={cn(CONTENT_WIDTH, 'gap-3 self-center px-4 pt-6 lg:px-8')}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="series-skeleton"
    >
      <Skeleton className="h-3 w-40 rounded-sm" />
      <Skeleton className="h-10 w-2/3 rounded-md" />
      <Skeleton className="h-3.5 w-1/2 rounded-sm" />
      <Skeleton className="mt-2 h-2.5 w-full rounded-sm" />
      <View className="mt-6 flex-row items-end justify-center" style={{ gap: 5 }}>
        {[0, 1, 2, 3, 4, 5].map((i) => {
          const { width, height } = spineDims(undefined, String(i * 7), scale);
          return (
            <View key={i} style={{ width, height }}>
              <Skeleton className="h-full w-full rounded-sm" />
            </View>
          );
        })}
      </View>
      <Skeleton className="h-4 w-full rounded-sm" />
      <View className="mt-6">
        <RowSkeletonList />
      </View>
    </View>
  );
}

/**
 * A series reached only by a community work id (nothing of it is in this library, so
 * there is no local series to list): `/meta/work` gives the work's title, authors and
 * first publication, but not its series rails (those come with a book the server can
 * match), so the page shows the work as a ghost and links out. The full bookcase shows
 * once a book of the series is on the listener's servers.
 */
export function WorkSeriesPage({ workId }: { workId: string }) {
  const { t } = useTranslation();
  const metadata = useCapability('metadata');
  const work = useMetaWork(workId, metadata === true);
  const paddingBottom = useMiniPlayerInset();
  if (metadata === undefined || work.isLoading) return <SeriesSkeleton />;
  const w = work.data;
  if (!w) {
    return <EmptyShelf title={t('series.work.hint')} hint={t('series.work.noRail')} />;
  }
  const year = /^\d{4}/.exec(w.first_published ?? '')?.[0];
  const link = w.attribution?.source_url;
  return (
    <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom }}>
      <View className={cn(CONTENT_WIDTH, 'gap-3 self-center px-4 pt-6 lg:px-8')}>
        <Text variant="eyebrow">{t('series.work.eyebrow')}</Text>
        <Text variant="display-xl" accessibilityRole="header">
          {w.title}
        </Text>
        <Text variant="muted">
          {[
            w.authors.map((a) => a.name).join(', '),
            year ? t('series.work.published', { year }) : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        <View className="mt-4 flex-row flex-wrap items-center gap-6">
          <GhostCover title={w.title} width={180} />
          <View className="max-w-[420px] shrink gap-3">
            <Text variant="title">{t('series.work.hint')}</Text>
            <Text variant="muted">{t('series.work.noRail')}</Text>
            {link ? (
              <Button
                variant="outline"
                icon="arrow-up-right"
                title={t('series.viewOnMeta')}
                role="link"
                onPress={() => void openExternalUrl(link)}
                className="self-start"
              />
            ) : null}
          </View>
        </View>
      </View>
    </ScrollView>
  );
}
