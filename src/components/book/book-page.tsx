import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, ScrollView, View } from 'react-native';

import {
  historyQuery,
  useBook,
  useBookMeta,
  useBookProgress,
  useCapability,
  useChapters,
  useLibraries,
} from '@/api/hooks';
import { useOptionalApi, useScopedCid } from '@/api/provider';
import { ContentScope } from '@/components/layout/content-scope';
import {
  BookMetaCharactersTab,
  BookMetaRecapsTab,
  BookMetaSeriesTab,
  matchedMeta,
  previousWorks,
  seriesRails,
  summaryIsVisible,
} from '@/components/library/book-meta';
import { bookTabs, parseBookTab, TAB_LABEL_KEY } from '@/components/library/book-tabs';
import { BookmarksSection } from '@/components/library/bookmarks-section';
import { bookStatus } from '@/components/library/books/books-view';
import { DownloadProgress } from '@/components/library/download-control';
import { HistorySection } from '@/components/library/history-section';
import {
  chapterStartsOf,
  LIVE_POSITION_BUCKET_S,
  listeningProgressFor,
  metaEnabledFor,
  splitCharacters,
} from '@/components/library/meta-gating';
import { NotesSection } from '@/components/library/notes-section';
import { TranscodeNote } from '@/components/library/transcode-note';
import { Attribution } from '@/components/player/companion/companion-pieces';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { selectIsLoaded } from '@/components/player/playing-target';
import { useListeningPosition } from '@/components/player/use-listening-position';
import { pinsOf, useBookAnnotations } from '@/components/player/use-playing-pins';
import { useBookSpeed, useBookTimeLeft } from '@/components/player/use-time-left';
import { ErrorNote } from '@/components/ui/query-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useDownloadEntry } from '@/downloads/store';
import { formatDuration, formatSpeed } from '@/lib/format';
import { CONTENT_WIDTH, useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { type BookTab, libraryHref, pathLeaf, segmentsToPath } from '@/lib/paths';
import { percentHeard } from '@/lib/progress-view';
import { useLatest } from '@/lib/use-latest';
import { cn } from '@/lib/utils';
import { codecLabel } from '@/playback/transcode';
import { useNeedsWebTranscode } from '@/playback/transcode-capability';
import { selectIsTransportLive, usePlayer } from '@/playback/store';
import { useSeriesOrderings } from '@/stores/series-orderings';
import { useSession } from '@/stores/session';
import { useSettings } from '@/stores/settings';
import { tabularNums } from '@/theme/tabular-nums';

import { type ListeningFigures, BookAside } from './book-aside';
import { BookChaptersTab } from './book-chapters-tab';
import { type BookCrumb, BookCrumbs } from './book-crumbs';
import { fileRows, playbackMode } from './book-details-model';
import { BookDetailsTab } from './book-details-tab';
import { BookHero } from './book-hero';
import {
  bookFacts,
  bookPageLayout,
  type ChapterList,
  chapterList,
  currentRow,
  formatRecordDate,
  heroEyebrow,
  type Jump,
  listenedSeconds,
  placeLine,
  primaryAction,
  startedAt,
} from './book-page-model';
import { BookSkeleton } from './book-skeleton';
import { HeroActions } from './hero-actions';
import { usePlayAt } from './use-play-at';

/** How long the page trusts its book's bookmarks and notes (the tab counts and pins):
 * every write invalidates them, so this only bounds another device's new ones. */
const ANNOTATIONS_STALE_MS = 60_000;

/** The listened figure shows from a minute up (a few seconds of history is noise). */
const LISTENED_MIN_S = 60;

const NO_LIST: ChapterList = { kind: 'chapters', rows: [] };

/**
 * The book page (`/book/[libraryId]?connection=&path=&tab=`), scoped to the route's OWN
 * `?connection=` (read from the local param, reliable on a cold deep link) so the body
 * and its sections resolve to that server.
 */
export function BookScreen() {
  return (
    <ContentScope>
      <BookPage />
    </ContentScope>
  );
}

/**
 * The Stacks book page (the prototype's `Book()`): a cover-tinted hero (`BookHero`) with
 * the listener's place and the actions, then the tabs (Chapters, the community tabs,
 * Bookmarks, History, Notes, Series, Details) and the aside (About, Other versions, Your
 * listening), laid out by the page's MEASURED width (`bookPageLayout`): the Up next
 * drawer can leave a desktop page phone-narrow.
 */
function BookPage() {
  const { t } = useTranslation();
  const {
    libraryId: libraryIdParam,
    path: pathParam,
    tab: tabParam,
  } = useLocalSearchParams<{
    libraryId: string;
    path?: string | string[];
    tab?: string | string[];
  }>();
  const libraryId = Number(libraryIdParam);
  const path = segmentsToPath(pathParam);
  const cid = useScopedCid();
  const api = useOptionalApi(cid);
  const [width, setWidth] = useState(0);
  const layout = bookPageLayout(useLayout(), width);
  const measure = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const paddingBottom = useMiniPlayerInset();
  const { openSeries, openAuthor, openNarrator } = useOpen();

  const { data: book, isLoading, refetch } = useBook(libraryId, path);
  const { data: chapterData, isLoading: chaptersLoading } = useChapters(libraryId, path);
  const { data: libraries } = useLibraries();
  const ratings = useCapability('ratings', cid) === true;
  const browsePeople = useCapability('browse_people', cid);
  // Community metadata is progressive enhancement: only a server advertising it is asked,
  // and only for a book with an ASIN or ISBN (one without can never match).
  const bookMetaEnabled = metaEnabledFor(useCapability('metadata', cid), book);
  const { data: meta } = useBookMeta(libraryId, path, bookMetaEnabled);
  // Where the listener is: the hero's place, the primary action, the spoiler gate.
  const progressQuery = useBookProgress(libraryId, path, true);
  const progress = progressQuery.data ?? undefined;
  const serverName = useSession((s) => s.connections.find((c) => c.id === cid)?.name ?? '');
  const interval = useSettings((s) => s.virtualChapterInterval);
  const relPath = book?.rel_path ?? path;
  const target = useMemo(
    () => ({ connectionId: cid, libraryId, path: relPath }),
    [cid, libraryId, relPath],
  );
  const loaded = usePlayer(selectIsLoaded(target));
  const live = usePlayer((s) => loaded && selectIsTransportLive(s));
  // The player's live whole-book position while this book is loaded (in the spoiler
  // gate's coarse steps, never below the saved one), else the saved one.
  const listeningPosition = useListeningPosition(
    target,
    progress?.position,
    LIVE_POSITION_BUCKET_S,
  );
  const downloaded = useDownloadEntry(cid, libraryId, path)?.status === 'downloaded';
  const transcoded = useNeedsWebTranscode(book, chapterData, cid);
  const annotations = useBookAnnotations(book ? target : null, ANNOTATIONS_STALE_MS);
  const pins = useMemo(
    () => pinsOf(annotations.bookmarks ?? [], annotations.notes ?? []),
    [annotations.bookmarks, annotations.notes],
  );
  const speed = useBookSpeed(target, progress?.playback_speed);
  const { play, playAt } = usePlayAt(cid, libraryId, book, chapterData);
  const onJump = useLatest((jump: Jump) => {
    playAt(jump).catch(() => toast({ title: t('library.bookActions.playFailed') }));
  });

  // The selected tab, held as an intent: which tabs EXIST depends on data that can arrive
  // late (or vanish), so the render falls back to the first available tab.
  const [tab, setTab] = useState<BookTab>(() => parseBookTab(tabParam) ?? 'chapters');
  // The spoiler reveal is held HERE, not per tab: revealing in Characters and switching
  // to Recaps must not re-hide everything the reader just chose to see.
  const [showSpoilers, setShowSpoilers] = useState(false);
  // The reader's reading order per series family, remembered on the device. It drives
  // BOTH the Series rail and "previous books".
  const orderingPicks = useSeriesOrderings((s) => s.picks);
  const pickOrdering = useSeriesOrderings((s) => s.pick);
  const metaMatched = matchedMeta(meta, bookMetaEnabled);
  const { rails, previousBooks } = useMemo(() => {
    const rails = metaMatched
      ? seriesRails(metaMatched.series, metaMatched.work.id, orderingPicks)
      : [];
    return { rails, previousBooks: previousWorks(rails) };
  }, [metaMatched, orderingPicks]);

  const chapters = useMemo(() => chapterData?.chapters ?? [], [chapterData]);
  const files = useMemo(() => chapterData?.files ?? [], [chapterData]);
  // The whole-book offset of every chapter, recomputed from the cumulative file durations
  // (the server's `book_offset` is unreliable): the spoiler gate, the rows, History.
  const chapterStarts = useMemo(() => chapterStartsOf(chapters, files), [chapters, files]);
  const historyChapters = useMemo(
    () => chapters.map((ch, i) => ({ ...ch, book_offset: chapterStarts[i] })),
    [chapters, chapterStarts],
  );
  const total = chapterData?.duration || book?.duration || 0;
  // Nothing until the chapters are in: a book's parts are only known once it is known
  // to have no chapters.
  const list = useMemo(
    () =>
      chapterData
        ? chapterList({ chapters, files, chapterStarts, total, interval, bookPath: relPath })
        : NO_LIST,
    [chapterData, chapters, files, chapterStarts, total, interval, relPath],
  );

  const status = progressQuery.isPending ? undefined : bookStatus(progress);
  const finished = status === 'finished' && !loaded;
  const started = loaded || status === 'progress' || (listeningPosition ?? 0) > 0;
  const position = finished ? total : (listeningPosition ?? 0);
  const current = currentRow(list.rows, position, started && !finished);
  const timeLeft = useBookTimeLeft(book ? target : null, progress, total);

  // Your listening: what this book's own records say, nothing estimated.
  const history = useQuery(historyQuery(cid, api, libraryId, started || finished ? path : '')).data;
  const now = new Date();
  const listenedS = history ? listenedSeconds(history) : 0;
  const startDate = startedAt(progress?.started_at, history);
  const finishedAt = finished && progress?.finished_at ? new Date(progress.finished_at) : null;
  const finishedDate =
    finishedAt && Number.isFinite(finishedAt.getTime())
      ? formatRecordDate(finishedAt, now)
      : undefined;
  const listening: ListeningFigures | null =
    started || finished
      ? {
          started: startDate ? formatRecordDate(startDate, now) : undefined,
          finished: finishedDate,
          speed: formatSpeed(speed),
          listened: listenedS >= LISTENED_MIN_S ? formatDuration(listenedS) : undefined,
        }
      : null;

  if (isLoading) {
    return (
      <ScrollView className="flex-1" onLayout={measure} contentContainerStyle={{ paddingBottom }}>
        <BookSkeleton layout={layout} />
      </ScrollView>
    );
  }
  // Render whenever we have book data, including a downloaded book served from the seeded
  // query cache while offline. Only error when there is no data.
  if (!book) {
    return (
      <View className="flex-1 p-4">
        <ErrorNote message={t('book.loadError')} onRetry={() => refetch()} />
      </View>
    );
  }

  const libraryName = libraries?.find((l) => l.id === libraryId)?.name ?? t('book.libraryFallback');
  const segments = path.split('/').filter(Boolean);
  const crumbs: BookCrumb[] = [
    { label: libraryName, onPress: () => router.push(libraryHref(cid, libraryId)) },
    ...segments.slice(0, -1).map((seg, i) => ({
      label: seg,
      onPress: () => router.push(libraryHref(cid, libraryId, segments.slice(0, i + 1).join('/'))),
    })),
    // The last crumb is the on-disk folder or file name (the hero shows the title).
    { label: pathLeaf(path) || book.title },
  ];

  // --- Community metadata and the spoiler gate -----------------------------------------
  const metaCharacters = metaMatched?.work.characters ?? [];
  const metaRecaps = metaMatched?.work.recaps ?? [];
  const metaSummary = metaMatched?.work.recap_summary;
  // ONE whole-book position mapped onto the REAL chapters (never the parts: they are
  // wall-clock slices, not the work's chapters).
  const gate = listeningProgressFor({
    chapterStarts,
    position: listeningPosition,
    finished: !!progress?.finished,
  });
  const summaryVisible = summaryIsVisible(metaSummary, gate.finished);
  const tabs = bookTabs({
    // Chapters arrive on their own request; the tab counts as present while it is in
    // flight, so the row doesn't start on Bookmarks and snap over.
    hasList: list.rows.length > 0 || chaptersLoading,
    hasRecaps: metaRecaps.length > 0,
    hasCharacters: metaCharacters.length > 0,
    hasSeries: rails.length > 0,
    hasPreviousBooks: previousBooks.length > 0,
    summaryVisible,
  });
  const activeTab = tabs.includes(tab) ? tab : tabs[0];
  const listLabel =
    list.kind === 'parts'
      ? t('book.chapters.parts')
      : list.kind === 'files'
        ? t('book.filesTitle')
        : t('book.chaptersTitle');
  const tabLabel = (v: BookTab): string => (v === 'chapters' ? listLabel : t(TAB_LABEL_KEY[v]));
  // Counts where they are already in hand (no extra request for a count).
  const counts: Partial<Record<BookTab, number>> = {
    chapters: list.rows.length || undefined,
    bookmarks: annotations.bookmarks?.length,
    notes: annotations.notes?.length,
    characters:
      metaCharacters.length > 0 ? splitCharacters(metaCharacters, gate).visible.length : undefined,
  };
  const attribution = metaMatched?.work.attribution;

  const tabContent = () => {
    switch (activeTab) {
      case 'chapters':
        if (list.rows.length === 0) {
          return (
            <View className="gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full rounded-control" />
              ))}
            </View>
          );
        }
        return (
          <BookChaptersTab
            list={list}
            total={total}
            position={position}
            started={started}
            finished={finished}
            loaded={loaded}
            pins={pins}
            roomy={layout.roomy}
            interval={interval}
            onJump={onJump}
          />
        );
      case 'recaps':
        return (
          <View className="gap-4">
            <BookMetaRecapsTab
              recaps={metaRecaps}
              progress={gate}
              summary={metaSummary}
              summaryVisible={summaryVisible}
              showSpoilers={showSpoilers}
              onToggleSpoilers={() => setShowSpoilers((v) => !v)}
              previousBooks={previousBooks}
            />
            {metaRecaps.length > 0 || summaryVisible ? (
              <Attribution attribution={attribution} />
            ) : null}
          </View>
        );
      case 'characters':
        return (
          <View className="gap-4">
            <BookMetaCharactersTab
              characters={metaCharacters}
              progress={gate}
              showSpoilers={showSpoilers}
              onToggleSpoilers={() => setShowSpoilers((v) => !v)}
              previousBooks={previousBooks}
            />
            {metaCharacters.length > 0 ? <Attribution attribution={attribution} /> : null}
          </View>
        );
      case 'bookmarks':
        return <BookmarksSection libraryId={libraryId} path={path} />;
      case 'history':
        return (
          <HistorySection
            libraryId={libraryId}
            path={path}
            chapters={historyChapters}
            emptyLabel={t('player.history.empty')}
          />
        );
      case 'notes':
        return <NotesSection libraryId={libraryId} path={path} />;
      case 'series':
        return <BookMetaSeriesTab rails={rails} onSelectView={pickOrdering} />;
      case 'details':
        return (
          <BookDetailsTab
            mode={playbackMode({ downloaded, transcoded })}
            codec={codecLabel(chapterData?.codec || book.codec)}
            serverName={serverName}
            libraryName={libraryName}
            path={book.rel_path}
            files={fileRows(book, chapterData)}
            roomy={layout.roomy}
          />
        );
    }
  };

  // The tab row and the active panel, inside the page's own vertical ScrollView (never a
  // nested vertical scroller); the row scrolls sideways.
  const tabSection = (
    <Tabs value={activeTab} onValueChange={(v) => setTab(v as BookTab)} className="gap-5">
      <TabsList scrollable>
        {tabs.map((v) => {
          const count = counts[v];
          return (
            <TabsTrigger key={v} value={v} testID={`book-tab-${v}`}>
              <Text>{tabLabel(v)}</Text>
              {count !== undefined ? (
                <Text
                  className="font-sans-semibold text-xs text-subtle-foreground"
                  style={tabularNums}
                >
                  {count}
                </Text>
              ) : null}
            </TabsTrigger>
          );
        })}
      </TabsList>
      <TabsContent value={activeTab}>{tabContent()}</TabsContent>
    </Tabs>
  );

  const percent = percentHeard(position, total, false);
  const showPlace = (loaded || status === 'progress') && !finished;
  const aside = (
    <BookAside
      book={book}
      connectionId={cid}
      meta={metaMatched}
      listening={listening}
      className={layout.columns === 1 ? 'mb-7' : undefined}
    />
  );

  return (
    <ScrollView
      testID="book-page"
      className="flex-1"
      onLayout={measure}
      contentContainerStyle={{ paddingBottom }}
    >
      <BookHero
        connectionId={cid}
        libraryId={libraryId}
        book={book}
        layout={layout}
        crumbs={<BookCrumbs crumbs={crumbs} />}
        eyebrow={heroEyebrow(t, book, libraryName, serverName)}
        facts={bookFacts(t, {
          book,
          list,
          interval,
          fileCount: files.length,
          codec: chapterData?.codec,
          publisher: metaMatched?.recording?.publisher,
          serverName,
          libraryName,
        })}
        place={
          showPlace
            ? {
                percent,
                fraction: total > 0 ? Math.min(1, position / total) : 0,
                line: placeLine(t, list.kind, current, list.rows.length),
                timeLeft,
              }
            : null
        }
        finished={finished ? { date: finishedDate } : null}
        ratings={ratings}
        onOpenSeries={
          book.series ? () => openSeries(cid, libraryId, { name: book.series }) : undefined
        }
        onOpenAuthor={book.author ? () => openAuthor(cid, libraryId, book.author) : undefined}
        onOpenNarrator={
          book.narrator && browsePeople !== false
            ? () => openNarrator(cid, libraryId, book.narrator)
            : undefined
        }
        actions={
          <HeroActions
            connectionId={cid}
            libraryId={libraryId}
            book={book}
            chapterData={chapterData}
            chaptersLoading={chaptersLoading}
            progress={progress}
            primary={primaryAction({
              status,
              loaded,
              live,
              chapter:
                list.kind === 'chapters' && list.rows.length > 1 && current >= 0
                  ? current + 1
                  : undefined,
            })}
            onPrimary={() =>
              void play().catch(() => toast({ title: t('library.bookActions.playFailed') }))
            }
            stacked={!layout.heroSide}
          />
        }
        footer={
          <>
            <DownloadProgress libraryId={libraryId} path={path} />
            <TranscodeNote
              book={book}
              chapterData={chapterData}
              connectionId={cid}
              downloaded={downloaded}
            />
          </>
        }
      />
      <View
        testID={`book-body-${layout.columns}`}
        className={cn(
          CONTENT_WIDTH,
          'self-center pt-6',
          layout.heroSide ? 'px-6 lg:px-8' : 'px-4',
          layout.columns === 2 && 'flex-row items-start gap-10',
        )}
      >
        {layout.columns === 1 ? aside : null}
        <View className="min-w-0 flex-1">{tabSection}</View>
        {layout.columns === 2 ? <View style={{ width: layout.aside }}>{aside}</View> : null}
      </View>
    </ScrollView>
  );
}
