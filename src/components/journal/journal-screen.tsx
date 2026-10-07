import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, View } from 'react-native';

import type { HistoryEntry, MyBookmark } from '@/api/types';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { SegmentedControl } from '@/components/ui/toggle-group';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';

import { AnnotationsTab } from './annotations-tab';
import { isDriftBookmark } from './annotations-bridge';
import { DiaryDayCard, DiarySkeleton } from './diary';
import { type DiarySpan, driftStrip, groupByDay, matchDrifts, toSpan } from './diary-model';
import { ExportActions } from './export-actions';
import { type JournalTab, parseJournalTab } from './journal-model';
import { mergeNewestFirst, overallStatus } from './merge-model';
import { fetchMoreOf, MoreSpinner, useJournalListProps } from './journal-list';
import { ServerNotes } from './server-notes';
import { useDriftRecords } from './use-drift-records';
import { useJournalExport } from './use-journal-export';
import { type Source, useJournalSources } from './use-journal-sources';

/** The measured widths the page's layout turns on (the Up next drawer can take 300-480
 * of a desktop, so the window size alone can't say). */
const WIDE_MIN = 600;
const EXPORT_INLINE_MIN = 520;

/** Total rows of a list across servers, when every server's list is complete (else
 * undefined: "100" while more pages wait would be a wrong count). */
function completeCount(sources: Source<unknown>[]): number | undefined {
  const able = sources.filter((s) => s.status !== 'unsupported');
  if (able.length === 0 || able.some((s) => s.status !== 'ready' || s.hasNextPage)) {
    return undefined;
  }
  return able.reduce((n, s) => n + s.rows.length, 0);
}

/**
 * The Journal (`/journal?tab=diary|bookmarks|notes`; Stacks prototype `Journal`): the
 * Diary of every day's listening, and every bookmark and note, on EVERY signed-in server,
 * merged newest first. Each server is asked through its own connection and gated on its
 * own capability; one failing or older server only adds a quiet note above the list.
 */
export function JournalScreen() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ tab?: string }>();
  const tab = parseJournalTab(params.tab);
  const [query, setQuery] = useState('');
  const [width, setWidth] = useState(0);
  const sources = useJournalSources();
  const exporter = useJournalExport(sources);

  const setTab = (next: JournalTab) =>
    router.setParams({ tab: next === 'diary' ? undefined : next });
  const wide = width >= WIDE_MIN;
  const annotationStatus = overallStatus([...sources.bookmarks, ...sources.notes]);

  const header = (
    <View className="gap-4 pb-4">
      <View
        className={cn(
          width >= EXPORT_INLINE_MIN ? 'flex-row items-end justify-between gap-4' : 'gap-3',
        )}
      >
        <View className="shrink gap-1">
          <Text variant="eyebrow">{t('journal.title')}</Text>
          <Text variant="display" accessibilityRole="header">
            {t('journal.heading')}
          </Text>
        </View>
        {annotationStatus === 'unsupported' ? null : (
          <ExportActions
            compact={width > 0 && width < EXPORT_INLINE_MIN}
            disabled={annotationStatus !== 'ready'}
            preparing={exporter.preparing}
            onRun={(format, action) => void exporter.run(format, action)}
          />
        )}
      </View>
      <View className={cn(wide ? 'flex-row items-center justify-between gap-3' : 'gap-3')}>
        <SegmentedControl
          options={[
            { value: 'diary', label: t('journal.tabs.diary') },
            {
              value: 'bookmarks',
              label: t('journal.tabs.bookmarks'),
              count: completeCount(sources.bookmarks),
            },
            { value: 'notes', label: t('journal.tabs.notes'), count: completeCount(sources.notes) },
          ]}
          value={tab}
          onChange={setTab}
          accessibilityLabel={t('journal.tabs.label')}
          className="self-start"
        />
        {tab === 'diary' ? null : (
          <Input
            value={query}
            onChangeText={setQuery}
            placeholder={t('journal.search.placeholder')}
            accessibilityLabel={t('journal.search.label')}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
            returnKeyType="search"
            containerClassName={wide ? 'w-[280px]' : 'w-full'}
          />
        )}
      </View>
    </View>
  );

  return (
    <View className="flex-1" onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {sources.feeders}
      {tab === 'diary' ? (
        <DiaryTab
          header={header}
          history={sources.history}
          bookmarks={sources.bookmarks}
          wide={wide}
        />
      ) : (
        <AnnotationsTab
          key={tab}
          kind={tab}
          header={header}
          query={query}
          bookmarks={sources.bookmarks}
          notes={sources.notes}
        />
      )}
    </View>
  );
}

function DiaryTab({
  header,
  history,
  bookmarks,
  wide,
}: {
  header: ReactNode;
  history: Source<HistoryEntry>[];
  bookmarks: Source<MyBookmark>[];
  wide: boolean;
}) {
  const { t } = useTranslation();
  const listProps = useJournalListProps();
  const records = useDriftRecords();
  const merged = useMemo(() => mergeNewestFirst(history, (r) => r.ended_at), [history]);
  const spans = useMemo(
    () => merged.rows.map(toSpan).filter((s): s is DiarySpan => s !== null),
    [merged.rows],
  );
  const days = useMemo(() => groupByDay(spans), [spans]);
  // The sleep timer's bookmarks, from the bookmarks loaded so far, each on the span it
  // ended (`matchDrifts`).
  const drifts = useMemo(() => {
    const all = mergeNewestFirst(bookmarks, (b) => b.created_at).rows;
    return matchDrifts(spans, all.filter(isDriftBookmark));
  }, [bookmarks, spans]);
  const now = useNow(60_000);
  const status = overallStatus(history);

  return (
    <FlatList
      {...listProps}
      data={days}
      keyExtractor={(d) => String(d.start)}
      ListHeaderComponent={
        <>
          {header}
          <ServerNotes sources={history} kind="history" />
        </>
      }
      ItemSeparatorComponent={() => <View className="h-4" />}
      renderItem={({ item }) => (
        <DiaryDayCard
          day={item}
          now={now}
          wide={wide}
          drifts={drifts}
          driftStripFor={(bm) => driftStrip(bm, records, now)}
        />
      )}
      ListEmptyComponent={
        status === 'loading' ? (
          <DiarySkeleton />
        ) : status === 'error' ? (
          <EmptyState
            variant="card"
            icon="circle-exclamation"
            title={t('journal.diary.error.title')}
            hint={t('journal.diary.error.hint')}
            action={{
              label: t('common.retry'),
              onPress: () => history.forEach((s) => s.refetch()),
            }}
          />
        ) : (
          <EmptyState
            variant="card"
            icon="history"
            title={t('journal.diary.empty.title')}
            hint={t('journal.diary.empty.hint')}
          />
        )
      }
      ListFooterComponent={<MoreSpinner visible={merged.isFetchingMore} />}
      onEndReached={() => fetchMoreOf(history, merged.fetchFrom)}
    />
  );
}
