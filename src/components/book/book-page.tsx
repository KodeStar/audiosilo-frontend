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
import { matchedMeta, summaryIsVisible } from '@/components/library/book-meta';
import { bookTabs, parseBookTab, TAB_LABEL_KEY } from '@/components/library/book-tabs';
import { bookStatus } from '@/components/library/books/books-view';
import { DownloadProgress } from '@/components/library/download-control';
import {
  chapterStartsOf,
  LIVE_POSITION_BUCKET_S,
  listeningProgressFor,
  metaEnabledFor,
  splitCharacters,
} from '@/components/library/meta-gating';
import { previousWorks, seriesRails } from '@/components/library/series-rails';
import { TranscodeNote } from '@/components/library/transcode-note';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { selectIsLoaded } from '@/components/player/playing-target';
import { useBookPlace } from '@/components/player/use-listening-position';
import { type PlayOptions, usePlayBook } from '@/components/player/use-play-book';
import { useBookAnnotations } from '@/components/player/use-playing-pins';
import { useBookSpeed, useBookTimeLeft } from '@/components/player/use-time-left';
import { ErrorNote } from '@/components/ui/query-state';
import { pathCrumbs } from '@/components/ui/breadcrumbs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useDownloadEntry } from '@/downloads/store';
import { CONTENT_WIDTH, useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { type BookTab, libraryHref, segmentsToPath } from '@/lib/paths';
import { percentHeard, progressFractionRemaining } from '@/lib/progress-view';
import { useLatest } from '@/lib/use-latest';
import { cn } from '@/lib/utils';
import { useNeedsWebTranscode } from '@/playback/transcode-capability';
import { selectIsTransportLive, usePlayer } from '@/playback/store';
import { useSeriesOrderings } from '@/stores/series-orderings';
import { useConnectionName } from '@/stores/session';
import { useSettings } from '@/stores/settings';
import { tabularNums } from '@/theme/tabular-nums';

import { BookAside } from './book-aside';
import { BookCrumbs } from './book-crumbs';
import { BookHero } from './book-hero';
import {
  bookFacts,
  bookPageLayout,
  type ChapterList,
  chapterList,
  heroEyebrow,
  type Jump,
  listeningFigures,
  placeLine,
  primaryAction,
  rowAt,
} from './book-page-model';
import { BookSkeleton } from './book-skeleton';
import { BookTabPanel } from './book-tab-panel';
import { HeroActions } from './hero-actions';

/** How long the page trusts its book's bookmarks and notes (the tab counts and pins):
 * every write invalidates them, so this only bounds another device's new ones. */
const ANNOTATIONS_STALE_MS = 60_000;

/** How long the page trusts the book's history (Your listening): a span this device
 * records refreshes it at once. */
const HISTORY_STALE_MS = 10 * 60_000;

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
  const serverName = useConnectionName(cid);
  const interval = useSettings((s) => s.virtualChapterInterval);
  const relPath = book?.rel_path ?? path;
  const target = useMemo(
    () => ({ connectionId: cid, libraryId, path: relPath }),
    [cid, libraryId, relPath],
  );
  const loaded = usePlayer(selectIsLoaded(target));
  const live = usePlayer((s) => loaded && selectIsTransportLive(s));
  // `listening`: the player's live whole-book position while this book is loaded (in the
  // spoiler gate's coarse steps, never below the saved one), else the saved one; the
  // spoiler gate reads it. `resume`: where a press on the primary plays from (the loaded
  // book toggles in place, at the player's place, even when another device saved one
  // further on): the hero's place, its Resume chapter N and the current row.
  const { listening: listeningPosition, resume: resumePosition } = useBookPlace(
    target,
    progress?.position,
    LIVE_POSITION_BUCKET_S,
  );
  const downloaded = useDownloadEntry(cid, libraryId, path)?.status === 'downloaded';
  const transcoded = useNeedsWebTranscode(book, chapterData, cid);
  // The tab counts and pins read the entries the Bookmarks and Notes tabs read and write
  // (`AnnotationSection`, keyed by the route's path, which can differ from `rel_path`), so
  // an add, edit or delete there moves them too.
  const listTarget = useMemo(
    () => ({ connectionId: cid, libraryId, path }),
    [cid, libraryId, path],
  );
  const annotations = useBookAnnotations(book ? listTarget : null, ANNOTATIONS_STALE_MS);
  const speed = useBookSpeed(target, progress?.playback_speed);
  // The primary toggles the loaded book in place (never restarting it); a chapter row, a
  // timeline tap or a pin jumps there (`usePlayBook`: a phone opens the player there).
  const playBook = usePlayBook();
  const play = (opts: PlayOptions) =>
    void playBook(target, opts).catch(() => toast({ title: t('library.bookActions.playFailed') }));
  const onJump = useLatest((jump: Jump) => play({ at: jump }));

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
  // (the server's `book_offset` is unreliable): the spoiler gate and the rows.
  const chapterStarts = useMemo(() => chapterStartsOf(chapters, files), [chapters, files]);
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
  const position = finished ? total : (resumePosition ?? 0);
  // The row the listener is in (none marked before the start or once finished).
  const current = started && !finished ? rowAt(list.rows, position) : -1;
  const timeLeft = useBookTimeLeft(book ? target : null, progress, total);

  // Your listening: what this book's own records say. A recorded span refreshes the
  // history (`qk.historyAll`), so it is trusted long: only another device's spans wait.
  const history = useQuery({
    ...historyQuery(cid, api, libraryId, started || finished ? path : ''),
    staleTime: HISTORY_STALE_MS,
  }).data;
  const listening = listeningFigures({
    started,
    finished,
    progress,
    history,
    speed,
    now: new Date(),
  });

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
  // The last crumb is the on-disk folder or file name (the hero shows the title).
  const crumbs = pathCrumbs(libraryName, path, (sub) =>
    router.push(libraryHref(cid, libraryId, sub)),
  );

  // --- Community metadata and the spoiler gate -----------------------------------------
  const metaCharacters = metaMatched?.work.characters ?? [];
  // ONE whole-book position mapped onto the REAL chapters (never the parts: they are
  // wall-clock slices, not the work's chapters).
  const gate = listeningProgressFor({
    chapterStarts,
    position: listeningPosition,
    finished: !!progress?.finished,
  });
  const summaryVisible = summaryIsVisible(metaMatched?.work.recap_summary, gate.finished);
  const tabs = bookTabs({
    // Chapters arrive on their own request; the tab counts as present while it is in
    // flight, so the row doesn't start on Bookmarks and snap over.
    hasList: list.rows.length > 0 || chaptersLoading,
    hasRecaps: (metaMatched?.work.recaps ?? []).length > 0,
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
      <TabsContent value={activeTab}>
        <BookTabPanel
          tab={activeTab}
          libraryId={libraryId}
          path={path}
          book={book}
          chapterData={chapterData}
          roomy={layout.roomy}
          chapters={{
            list,
            total,
            position,
            current,
            finished,
            loaded,
            pins: annotations.pins,
            interval,
            onJump,
          }}
          community={{
            meta: metaMatched,
            gate,
            summaryVisible,
            showSpoilers,
            onToggleSpoilers: () => setShowSpoilers((v) => !v),
            rails,
            previousBooks,
            onSelectView: pickOrdering,
          }}
          details={{ downloaded, transcoded, serverName, libraryName }}
        />
      </TabsContent>
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
                fraction: progressFractionRemaining(position, total).fraction,
                line: placeLine(t, list.kind, current, list.rows.length, list.rows[current]?.title),
                timeLeft,
              }
            : null
        }
        finished={finished ? { date: listening?.finished } : null}
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
              chapterTitle: list.rows[current]?.title,
            })}
            onPrimary={() => play({ toggle: true })}
            stacked={!layout.heroSide}
          />
        }
        footer={
          <>
            <DownloadProgress libraryId={libraryId} path={path} />
            <TranscodeNote
              book={book}
              chapterData={chapterData}
              transcoded={transcoded}
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
