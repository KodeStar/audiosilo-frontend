import { type InfiniteData, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, ScrollView, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { isNotInLibraryError } from '@/api/client';
import {
  historyQuery,
  qk,
  useBook,
  useBookMeta,
  useBookProgress,
  useCapability,
  useChapters,
  useIsPodcastLibrary,
  useLibraries,
} from '@/api/hooks';
import { useCid, useOptionalApi } from '@/api/provider';
import type { Listing } from '@/api/types';
import { GenerateCovered } from '@/components/bridge/generate-covered';
import { GenerateDialog } from '@/components/bridge/generate-dialog';
import { GenerateStatus } from '@/components/bridge/generate-status';
import { useGenerate } from '@/components/bridge/use-generate';
import { ContentScope } from '@/components/layout/content-scope';
import { NotInLibraryState } from '@/components/layout/not-in-library';
import { LoadFailedNote } from '@/components/layout/sign-in-again';
import { bookMetaWork, matchedMeta, summaryIsVisible } from '@/components/library/book-meta';
import { bookTabs, parseBookTab, TAB_LABEL_KEY } from '@/components/library/book-tabs';
import { bookStatus } from '@/components/library/books/books-view';
import { DownloadProgress } from '@/components/library/download-control';
import {
  chapterStartsOf,
  LIVE_POSITION_BUCKET_S,
  listeningProgressFor,
  metaAnswered,
  metaEnabledFor,
  splitCharacters,
} from '@/components/library/meta-gating';
import { previousWorks, seriesRails } from '@/components/library/series-rails';
import { TranscodeNote } from '@/components/library/transcode-note';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { EpisodePage } from '@/components/podcasts/episode-page';
import { selectIsLoaded } from '@/components/player/playing-target';
import { useBookPlace } from '@/components/player/use-listening-position';
import { type PlayOptions, usePlayBook } from '@/components/player/use-play-book';
import { useBookAnnotations } from '@/components/player/use-playing-pins';
import { useBookSpeed, useBookTimeLeft } from '@/components/player/use-time-left';
import { bookCrumbs } from '@/components/ui/breadcrumbs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Text } from '@/components/ui/text';
import { playFailedToast } from '@/components/player/play-failed';
import { useIsDownloaded } from '@/downloads/store';
import { CONTENT_WIDTH, useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import {
  type BookTab,
  bookTitle,
  idParam,
  libraryHref,
  parentPath,
  segmentsToPath,
} from '@/lib/paths';
import { percentHeard, progressFractionRemaining } from '@/lib/progress-view';
import { useRouteParams } from '@/lib/route-params';
import { useLatest } from '@/lib/use-latest';
import { usePageTitle } from '@/lib/use-page-title';
import { cn } from '@/lib/utils';
import { useNeedsWebTranscode } from '@/playback/transcode-capability';
import { selectIsTransportLive, usePlayer } from '@/playback/store';
import { useBookTimeSaved } from '@/playback/time-saved';
import { useLibraryName } from '@/stores/library-names';
import { useSeriesOrderings } from '@/stores/series-orderings';
import { useConnectionName } from '@/stores/session';
import { useSettings } from '@/stores/settings';
import { tabularNums } from '@/theme/tabular-nums';

import { BookAside } from './book-aside';
import { BookCrumbs } from './book-crumbs';
import { bookPublisher } from './book-details-model';
import { BookHero } from './book-hero';
import {
  bookFacts,
  bookPageLayout,
  type ChapterList,
  chapterList,
  heroEyebrow,
  type Jump,
  knownChaptersSource,
  listeningFigures,
  placeLine,
  primaryAction,
  rowAt,
} from './book-page-model';
import { BookSkeleton } from './book-skeleton';
import { BookTabPanel } from './book-tab-panel';
import { HeroActions } from './hero-actions';
import { ListeningOfferLine } from './listening-offer';

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
      <BookRoute />
    </ContentScope>
  );
}

/** A link that can't name a book (no positive library id, no path: `/book/abc`) asks the
 * server nothing and shows the not-in-library state (frontend#129). */
function BookRoute() {
  const { libraryId, path } = useRouteParams<{ libraryId?: string; path?: string | string[] }>();
  if (idParam(libraryId) === null || !segmentsToPath(path)) return <NotInLibraryState />;
  return <BookOrEpisode />;
}

/**
 * An item that is a podcast episode (`book.episode`; while the item is not in yet, any
 * item of a podcast library) gets its own page (`EpisodePage`, Bridge Phase 2d-1) at the
 * same link; a book the book page.
 */
function BookOrEpisode() {
  const { libraryId: libraryIdParam, path: pathParam } = useRouteParams<{
    libraryId: string;
    path?: string | string[];
  }>();
  const libraryId = Number(libraryIdParam);
  const path = segmentsToPath(pathParam);
  // The route's `?connection=`, else the default server (a link without one).
  const cid = useCid();
  const podcastLibrary = useIsPodcastLibrary(libraryId, cid);
  const { data: book } = useBook(libraryId, path);
  const canonical = useCanonicalBookPath(cid, libraryId, path, book);
  useRefreshPendingListing(cid, libraryId, book);
  // A file path on its way to its book's path: nothing reads or writes a place under it.
  if (!canonical) return null;
  // The item's own shape once it is in (an item of a podcast library that is no episode
  // gets the book page, never a blank one).
  return (book ? book.episode : podcastLibrary) ? (
    <EpisodePage libraryId={libraryId} path={path} />
  ) : (
    <BookPage />
  );
}

/**
 * Path is the identity (CROSS-REPO section 1): a link to a track file or a disc folder inside
 * a book, which `/item` resolves to the book above it, moves the route to the book's own
 * `rel_path` in place (`setParams`: no history entry, so Back never returns to the file
 * path), and the page renders only then. Its progress, its plays and its cast are asked by
 * the book's path, never under a second key that hides the real place (frontend#130). The
 * item already read seeds the book path's query, so the move asks nothing again. Only to a
 * folder above the route's path (each move is shorter, so it can never bounce); any other
 * difference (a trailing slash) is the same book and stays. False while the route is on
 * its way.
 */
function useCanonicalBookPath(
  cid: string,
  libraryId: number,
  path: string,
  book: { rel_path: string } | undefined,
): boolean {
  const qc = useQueryClient();
  const target = book?.rel_path.replace(/\/+$/, '');
  const move = !!target && path.startsWith(`${target}/`);
  useEffect(() => {
    if (!move || !target || !book) return;
    const key = qk.item(cid, libraryId, target);
    if (qc.getQueryData(key) === undefined) qc.setQueryData(key, book);
    router.setParams({ path: target });
  }, [move, target, cid, libraryId, qc, book]);
  return !move;
}

/**
 * A folder its browse listing flagged `pending_book` (server#193) is indexed by the read
 * that opened it here, so that cached listing is marked stale (refetched now while it is
 * still on the stack below): going back shows the book's title, not "Not scanned yet".
 * Opening an indexed book asks the listing nothing.
 */
function useRefreshPendingListing(
  cid: string,
  libraryId: number,
  book: { rel_path: string } | undefined,
) {
  const qc = useQueryClient();
  const rel = book?.rel_path.replace(/\/+$/, '');
  useEffect(() => {
    if (!rel) return;
    const key = qk.browse(cid, libraryId, parentPath(rel));
    const listing = qc.getQueryData<InfiniteData<Listing>>(key);
    if (listing?.pages.some((p) => p.entries.some((e) => e.pending_book && e.path === rel)))
      void qc.invalidateQueries({ queryKey: key, exact: true });
  }, [rel, cid, libraryId, qc]);
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
  } = useRouteParams<{
    libraryId: string;
    path?: string | string[];
    tab?: string | string[];
  }>();
  const libraryId = Number(libraryIdParam);
  const path = segmentsToPath(pathParam);
  const cid = useCid();
  const api = useOptionalApi(cid);
  const [width, setWidth] = useState(0);
  const layout = bookPageLayout(useLayout(), width);
  const measure = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const paddingBottom = useMiniPlayerInset();
  const { openSeries, openAuthor, openNarrator } = useOpen();

  const { data: book, isLoading, error, refetch } = useBook(libraryId, path);
  usePageTitle(book ? bookTitle(book.title, path) : undefined);
  const { data: chapterData, isLoading: chaptersLoading } = useChapters(libraryId, path);
  const { data: libraries } = useLibraries();
  // Offline the live list may never come: the name the server last listed (PLAYER-09).
  const keptLibraryName = useLibraryName(cid, libraryId);
  const ratings = useCapability('ratings', cid) === true;
  const browsePeople = useCapability('browse_people', cid);
  const relPath = book?.rel_path ?? path;
  // Community metadata is progressive enhancement: only a server advertising it is asked,
  // and only for a book with an ASIN or ISBN (one without can never match) or with
  // content generated on this server (characters, recaps or a description). Asked by the
  // book's own path, as every other surface asks (and as a finished Bridge job reads it
  // again).
  const bookMetaEnabled = metaEnabledFor(useCapability('metadata', cid), book);
  const { data: meta } = useBookMeta(libraryId, relPath, bookMetaEnabled);
  // What About's text and the Characters and Recaps tabs render: the matched work, or an
  // unmatched book's content generated on this server (the rails, the AudioSilo Meta links
  // and About's recording facts stay matched-only).
  const metaWork = bookMetaWork(meta, bookMetaEnabled);
  // Where the listener is: the hero's place, the primary action, the spoiler gate.
  // Only once the item is in: until then the route's path may be a file inside the book,
  // which `useCanonicalBookPath` moves away from before anything reads a place (#130).
  const progressQuery = useBookProgress(libraryId, path, !!book);
  const progress = progressQuery.data ?? undefined;
  const serverName = useConnectionName(cid);
  const interval = useSettings((s) => s.virtualChapterInterval);
  // An admin's "Generate characters and recaps" (Bridge Phase 1a): offered while the
  // community lacks either (Phase 1e), by the server's Bridge; its job's status shows under
  // the actions meanwhile (and reads the screen's focus itself, so a blur re-renders it
  // alone, not the page). A book the community covers says so instead.
  const generate = useGenerate({
    // The jobs carry the book's own path: nothing is asked until the book is in.
    target: { connectionId: cid, libraryId, path: book?.rel_path ?? '' },
    content: metaWork,
    // A book /meta isn't asked for has nothing to wait for; a failed lookup is no answer.
    metaKnown: metaAnswered(bookMetaEnabled, book, meta),
  });
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
  // Downloads are keyed by the book's own path (`rel_path`), as the hero's control reads them.
  const downloaded = useIsDownloaded(cid, libraryId, relPath);
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
    void playBook(target, opts).catch((err) => playFailedToast(err));
  const onJump = useLatest((jump: Jump) => play({ at: jump }));

  // The selected tab, held as an intent: which tabs EXIST depends on data that can arrive
  // late (or vanish), so the render falls back to the first available tab.
  const [tab, setTab] = useState<BookTab>(() => parseBookTab(tabParam) ?? 'chapters');
  // The spoiler reveal is held HERE, not per tab: revealing in Characters and switching
  // to Recaps must not re-hide everything the reader just chose to see.
  const [showSpoilers, setShowSpoilers] = useState(false);
  // The covered line's "See characters": the Characters tab, brought into view. The tabs
  // are measured against the scroller's content on press, once the tab switch has
  // committed (a frame later): a position cached from onLayout goes stale on the web,
  // which reports a layout only when a view's size changes, never when it just moves.
  const scrollRef = useRef<ScrollView>(null);
  const contentRef = useRef<View>(null);
  const tabsRef = useRef<View>(null);
  const reduced = useReducedMotion();
  const openCharacters = () => {
    setTab('characters');
    requestAnimationFrame(() => {
      const content = contentRef.current;
      if (!content) return;
      tabsRef.current?.measureLayout(content, (_x, y) =>
        scrollRef.current?.scrollTo({ y, animated: !reduced }),
      );
    });
  };
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
  // Smart Speed's seconds saved on this book, kept on this device (`time-saved.ts`).
  const smartSpeedSaved = useBookTimeSaved(cid, libraryId, relPath);
  const listening = listeningFigures({
    started,
    finished,
    progress,
    history,
    speed,
    smartSpeedSaved,
    now: new Date(),
  });

  // The skeleton and the page share these: the skeleton mounts the scroller the loaded page
  // then updates, and react-native-web's ScrollView hands its node to a forwarded ref only
  // at mount, so a ref first passed on an update would stay null on the web.
  const scrollerProps = {
    ref: scrollRef,
    className: 'flex-1',
    onLayout: measure,
    contentContainerStyle: { paddingBottom },
  };

  if (isLoading) {
    return (
      <ScrollView {...scrollerProps}>
        <BookSkeleton layout={layout} />
      </ScrollView>
    );
  }
  // Render whenever we have book data, including a downloaded book served from the seeded
  // query cache while offline. Only error when there is no data.
  if (!book) {
    // A 404 or 403 is a book that isn't there for this listener: no Retry (CONNECT-13).
    if (isNotInLibraryError(error)) return <NotInLibraryState />;
    return (
      <View className="flex-1 p-4">
        <LoadFailedNote cid={cid} message={t('book.loadError')} onRetry={() => refetch()} />
      </View>
    );
  }

  const libraryName =
    libraries?.find((l) => l.id === libraryId)?.name ??
    keptLibraryName ??
    t('book.libraryFallback');
  const crumbs = bookCrumbs(libraryName, path, bookTitle(book.title, path), (sub) =>
    router.push(libraryHref(cid, libraryId, sub)),
  );

  // --- Community metadata and the spoiler gate -----------------------------------------
  const metaCharacters = metaWork?.characters ?? [];
  // ONE whole-book position mapped onto the REAL chapters (never the parts: they are
  // wall-clock slices, not the work's chapters).
  const gate = listeningProgressFor({
    chapterStarts,
    position: listeningPosition,
    finished: !!progress?.finished,
  });
  const summaryVisible = summaryIsVisible(metaWork?.recap_summary, gate.finished);
  const tabs = bookTabs({
    // Chapters arrive on their own request; the tab counts as present while it is in
    // flight, so the row doesn't start on Bookmarks and snap over.
    hasList: list.rows.length > 0 || chaptersLoading,
    hasRecaps: (metaWork?.recaps ?? []).length > 0,
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
            source: knownChaptersSource(chapterData?.chapters_source),
            onJump,
          }}
          community={{
            work: metaWork,
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
      work={metaWork}
      listening={listening}
      className={layout.columns === 1 ? 'mb-7' : undefined}
    />
  );

  return (
    <ScrollView testID="book-page" {...scrollerProps}>
      {/* The content the covered line's "See characters" measures the tabs against. */}
      <View ref={contentRef}>
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
            publisher: bookPublisher(book, metaMatched?.recording),
            serverName,
            libraryName,
          })}
          place={
            showPlace
              ? {
                  percent,
                  fraction: progressFractionRemaining(position, total).fraction,
                  line: placeLine(
                    t,
                    list.kind,
                    current,
                    list.rows.length,
                    list.rows[current]?.title,
                  ),
                  timeLeft,
                }
              : null
          }
          finished={finished ? { date: listening?.finished } : null}
          ratings={ratings}
          onOpenSeries={(name) => openSeries(cid, libraryId, { name })}
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
              generate={
                generate.offer
                  ? { offer: generate.offer, onPress: () => generate.setConfirming(true) }
                  : undefined
              }
            />
          }
          footer={
            <>
              <DownloadProgress libraryId={libraryId} path={relPath} />
              <ListeningOfferLine
                target={target}
                row={progress}
                here={resumePosition}
                chapters={chapterData?.chapters ?? []}
                onPlay={(position) => play({ at: { position } })}
              />
              <GenerateStatus model={generate} />
              {generate.covered ? <GenerateCovered onOpen={openCharacters} /> : null}
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
          <View ref={tabsRef} className="min-w-0 flex-1">
            {tabSection}
          </View>
          {layout.columns === 2 ? <View style={{ width: layout.aside }}>{aside}</View> : null}
        </View>
      </View>
      <GenerateDialog model={generate} title={book.title} />
    </ScrollView>
  );
}
