import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import {
  useBook,
  useBookMeta,
  useBookProgress,
  useChapters,
  useLibraries,
  useServerInfo,
} from '@/api/hooks';
import { CoverFrame } from '@/components/library/cover-frame';
import { useApi, useScopedCid } from '@/api/provider';
import { ContentScope } from '@/components/layout/content-scope';
import {
  BookMetaAbout,
  BookMetaCharactersTab,
  BookMetaRecapsTab,
  BookMetaSeriesTab,
  matchedMeta,
  previousWorks,
  seriesRails,
  summaryIsVisible,
} from '@/components/library/book-meta';
import { type BookTab, bookTabs, TAB_LABEL_KEY } from '@/components/library/book-tabs';
import { listeningProgressFor } from '@/components/library/meta-gating';
import { BookmarksSection } from '@/components/library/bookmarks-section';
import { BookStats } from '@/components/library/book-stats';
import { BookVersions } from '@/components/library/book-versions';
import { DownloadControl, DownloadProgress } from '@/components/library/download-control';
import { HistorySection } from '@/components/library/history-section';
import { NotesSection } from '@/components/library/notes-section';
import { CoverBackdrop } from '@/components/player/cover-backdrop';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { BreadCrumbs, type Crumb } from '@/components/ui/breadcrumbs';
import { Button } from '@/components/ui/button';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { ErrorNote } from '@/components/ui/query-state';
import { Skeleton } from '@/components/ui/skeleton';
import { TabBar } from '@/components/ui/tab-bar';
import { Text } from '@/components/ui/text';
import { useDownloadEntry } from '@/downloads/store';
import { formatBitrate, formatDurationFull } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { libraryHref, pathLeaf, segmentsToPath } from '@/lib/paths';
import { chapterBookOffset } from '@/playback/book-queue';
import { prettifyChapterTitle } from '@/playback/prettify-title';
import { selectBookPosition, selectCurrentChapter, usePlayer } from '@/playback/store';
import { useSeriesOrderings } from '@/stores/series-orderings';
import { tabularNums } from '@/theme/tabular-nums';
import { colors } from '@/theme/tokens';
import { useThemeColors } from '@/theme/use-theme-colors';

// How coarsely this screen samples the player's live position (seconds). The only
// consumer is the spoiler gate, which just needs to know which CHAPTER the listener
// is in, so subscribing to the per-tick position would re-render a list of possibly
// hundreds of chapter rows every second for nothing. Rounding DOWN can delay a
// reveal by at most this many seconds at a chapter boundary - it can never reveal
// something early, which is the direction that matters.
const LIVE_POSITION_BUCKET_S = 15;

/** Loading placeholder shaped like the final layout: a cover block, title lines,
 * a stat strip and a few chapter rows - no centered spinner. */
function BookSkeleton({ paddingBottom }: { paddingBottom: number }) {
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-6 p-4"
      contentContainerStyle={{ paddingBottom }}
    >
      <View className="items-center gap-4">
        <Skeleton className="aspect-square w-full max-w-[240px] rounded-lg" />
        <View className="w-full items-center gap-2">
          <Skeleton className="h-4 w-1/2 rounded-sm" />
          <Skeleton className="h-6 w-3/4 rounded-sm" />
        </View>
      </View>
      <Skeleton className="h-20 w-full rounded-xl" />
      <Skeleton className="h-12 w-full rounded-lg" />
      <View className="gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </View>
    </ScrollView>
  );
}

// Scope to the route's OWN `?connection=` (read from the local param, reliable on a cold
// deep link) so the body + its sections resolve to that server. The body consumes the
// scope via `useScopedCid()`, so it lives in a child component of `<ContentScope>`.
export default function BookDetailScreen() {
  return (
    <ContentScope>
      <BookDetailContent />
    </ContentScope>
  );
}

function BookDetailContent() {
  const themed = useThemeColors();
  const { t } = useTranslation();
  const { libraryId: libraryIdParam, path: pathParam } = useLocalSearchParams<{
    libraryId: string;
    path?: string | string[];
  }>();
  const libraryId = Number(libraryIdParam);
  const path = segmentsToPath(pathParam);
  const api = useApi();
  // The connection rides in the `?connection=` query param; the `(app)` layout publishes
  // it as the scope, so this screen's content resolves to that server (not the default).
  const cid = useScopedCid();
  // Tablet and desktop get the two-pane layout (the cover panel is narrower on a
  // tablet); a phone gets the single column.
  const layout = useLayout();
  const wide = layout !== 'phone';

  const { data: book, isLoading, refetch } = useBook(libraryId, path);
  const { data: chapterData, isLoading: chaptersLoading } = useChapters(libraryId, path);
  const { data: libraries } = useLibraries();
  // Enriched community metadata is progressive enhancement, gated on the server
  // advertising the capability (older servers omit the flag → false → no query).
  const { data: server } = useServerInfo();
  const metadataEnabled = !!server?.capabilities.metadata;
  // Older servers omit the capability → false; books with neither id can never
  // match, so we skip the request entirely.
  const bookMetaEnabled = metadataEnabled && !!(book?.asin || book?.isbn);
  const { data: meta } = useBookMeta(libraryId, path, bookMetaEnabled);
  // Where the listener has got to, for the spoiler gating below - so it rides the
  // same gate: with no metadata to gate, this authenticated GET would be waste.
  const { data: progress } = useBookProgress(libraryId, path, bookMetaEnabled);

  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const currentChapter = usePlayer(selectCurrentChapter);
  // The player's live whole-book POSITION, bucketed (see LIVE_POSITION_BUCKET_S) and
  // zeroed unless this library on this connection is the one playing - so an unrelated
  // book playing elsewhere never re-renders this screen. The caller still checks
  // `isThisPlaying` (which also matches the path) before trusting it.
  const livePosition = usePlayer((s) =>
    s.nowPlaying?.connectionId === cid && s.nowPlaying.libraryId === libraryId
      ? Math.floor(selectBookPosition(s) / LIVE_POSITION_BUCKET_S) * LIVE_POSITION_BUCKET_S
      : 0,
  );
  const downloadEntry = useDownloadEntry(cid, libraryId, path);
  const paddingBottom = useMiniPlayerInset();
  // The selected tab. Held as an intent: which tabs EXIST depends on data that
  // can arrive late (or vanish), so the render below falls back to the first
  // available tab rather than showing a blank panel.
  const [tab, setTab] = useState<BookTab>('chapters');
  // The spoiler reveal is held HERE, not per tab: revealing in Characters and
  // switching to Recaps must not re-hide everything the reader just chose to see.
  const [showSpoilers, setShowSpoilers] = useState(false);
  // The reader's reading order per series family (Publication / Chronological / ...),
  // remembered on the device. It drives BOTH the Series rail and "previous books", so
  // catching up never draws on an order the reader is not following.
  const orderingPicks = useSeriesOrderings((s) => s.picks);
  const pickOrdering = useSeriesOrderings((s) => s.pick);
  // The community metadata, when there is a match to show (see the tabs below).
  const metaMatched = matchedMeta(meta, bookMetaEnabled);
  // One series rail per family, showing the picked order, and the earlier books of
  // those SAME rails for the "catch up on previous books" block appended to the
  // Recaps and Characters tabs (each row fetches its own work lazily, on open).
  // Computed once, above the early returns, so the memo is a real hook.
  const { rails, previousBooks } = useMemo(() => {
    const rails = metaMatched
      ? seriesRails(metaMatched.series, metaMatched.work.id, orderingPicks)
      : [];
    return { rails, previousBooks: previousWorks(rails) };
  }, [metaMatched, orderingPicks]);

  // Chapters/files and their whole-book offsets. Computed ABOVE the early returns
  // (they derive from `chapterData` alone, and cost nothing while it is undefined)
  // so the memo is a real hook, called on every render.
  const chapters = useMemo(() => chapterData?.chapters ?? [], [chapterData]);
  const files = useMemo(() => chapterData?.files ?? [], [chapterData]);
  // The whole-book offset of every chapter. The server's `book_offset` is unreliable,
  // so it is recomputed from the cumulative file durations (shared with book-queue) -
  // an O(chapters x files) pass, memoized because the History and metadata tabs read
  // it on every render, including while parked on another tab.
  const chapterStarts = useMemo(() => {
    if (files.length === 0) return chapters.map((ch) => ch.book_offset);
    const fileDurations = files.map((f) => ({ path: f.rel_path, duration: f.duration }));
    return chapters.map((ch) => chapterBookOffset(fileDurations, ch));
  }, [chapters, files]);
  // Chapters carrying the corrected offset, so the History tab can label each
  // listening span with its chapter.
  const historyChapters = useMemo(
    () => chapters.map((ch, i) => ({ ...ch, book_offset: chapterStarts[i] })),
    [chapters, chapterStarts],
  );

  if (isLoading) return <BookSkeleton paddingBottom={paddingBottom} />;
  // Render whenever we have book data - including a downloaded book served from
  // the seeded query cache while offline. Only error when there is no data.
  if (!book) {
    return (
      <View className="flex-1 p-4">
        <ErrorNote message={t('book.loadError')} onRetry={() => refetch()} />
      </View>
    );
  }

  const seriesLabel = book.series
    ? book.series_index
      ? `${book.series} #${book.series_index}`
      : book.series
    : '';
  const coverUrl = api.coverUrl(libraryId, path);
  const coverHeaders = api.authHeaders();
  const coverSource = { uri: coverUrl, headers: coverHeaders };
  const listLabel = chapters.length > 0 ? t('book.chaptersTitle') : t('book.filesTitle');
  const isThisPlaying =
    nowPlaying?.connectionId === cid &&
    nowPlaying?.libraryId === libraryId &&
    nowPlaying?.path === book.rel_path;
  const activeIndex = isThisPlaying ? currentChapter?.index : undefined;
  const downloaded = downloadEntry?.status === 'downloaded';

  const libraryName = libraries?.find((l) => l.id === libraryId)?.name ?? t('book.libraryFallback');
  const segments = path.split('/').filter(Boolean);
  const crumbs: Crumb[] = [
    { label: libraryName, onPress: () => router.push(libraryHref(cid, libraryId)) },
    ...segments.slice(0, -1).map((seg, i) => ({
      label: seg,
      onPress: () => router.push(libraryHref(cid, libraryId, segments.slice(0, i + 1).join('/'))),
    })),
    // The active crumb is the on-disk folder/file name (matching the other path
    // crumbs and the browse view); the book's title is shown in the header below.
    { label: pathLeaf(path) || book.title, active: true },
  ];

  // On tablet/desktop play inline (the docked player bar is the transport); on phone
  // open the full-screen player modal. A chapter is addressed by whole-book position;
  // a file by track index (durations may be unknown, so a position can't locate it).
  const goPlay = (target: { position?: number; track?: number }) => {
    if (wide) {
      void usePlayer
        .getState()
        .playBook(cid, libraryId, book, chapterData, target.position, target.track);
    } else {
      router.push({
        pathname: '/player',
        params: {
          connection: cid,
          libraryId: String(libraryId),
          path,
          ...(target.position !== undefined
            ? { position: String(Math.round(target.position)) }
            : {}),
          ...(target.track !== undefined ? { track: String(target.track) } : {}),
        },
      });
    }
  };

  // A quiet chapter/file row: a numbered tile (or a play glyph on a pink tile when
  // this row is the one currently playing), the title, a tabular duration/bitrate
  // line, and a small success check when the book is downloaded. The blue block is
  // gone; the currently-playing row lifts to a soft brand tint.
  const fileRow = (
    key: string | number,
    name: string,
    durationSec: number,
    bitrate: string,
    onPress: () => void,
    index: number,
    active: boolean,
  ) => (
    <AnimatedPressable
      key={key}
      onPress={onPress}
      accessibilityRole="button"
      // The dark border is on every row, playing or not, so a row keeps one height.
      className={`my-1 w-full flex-row items-center gap-3 rounded-xl px-3 py-2.5 dark:border dark:border-border ${
        active ? 'bg-brand/10 dark:bg-brand/15' : 'bg-card shadow-xs dark:shadow-none'
      }`}
    >
      <View
        className={`h-9 w-9 items-center justify-center rounded-lg ${active ? 'bg-brand' : 'bg-muted'}`}
      >
        {active ? (
          <Icon name="play" size={13} color={colors.white} />
        ) : (
          <Text className="font-sans-semibold text-sm text-muted-foreground" style={tabularNums}>
            {index}
          </Text>
        )}
      </View>
      <View className="flex-1">
        <Text variant="label" numberOfLines={1} className={active ? 'text-brand-ink' : ''}>
          {prettifyChapterTitle(name)}
        </Text>
        <Text variant="caption" style={tabularNums}>
          {`${t('book.duration', { value: formatDurationFull(durationSec) })}${
            bitrate ? `   ${t('book.bitrate', { value: bitrate })}` : ''
          }`}
        </Text>
      </View>
      {downloaded ? (
        <View className="h-5 w-5 items-center justify-center rounded-full bg-success/15">
          <Icon name="check" size={11} color={themed.success} />
        </View>
      ) : null}
    </AnimatedPressable>
  );

  const renderRows = () => {
    if (chapters.length > 0) {
      return chapters.map((ch, i) => {
        // Highlight only the active chapter among several. With one row there's
        // nothing to distinguish, and the player may report a *synthetic* chapter
        // index (virtual chapters overlaid on an otherwise-chapterless single file)
        // that maps to no real row - so never highlight the lone row.
        const active =
          chapters.length > 1 &&
          isThisPlaying &&
          activeIndex !== undefined &&
          ch.index === activeIndex;
        const file = files[ch.file_index];
        return fileRow(
          ch.index,
          ch.title || t('book.chapterFallback', { number: ch.index + 1 }),
          Math.max(0, ch.end - ch.start),
          formatBitrate(file?.size, file?.duration),
          () => goPlay({ position: chapterStarts[i] }),
          i + 1,
          active,
        );
      });
    }
    return files.map((f, i) =>
      fileRow(
        f.rel_path,
        pathLeaf(f.rel_path),
        f.duration,
        formatBitrate(f.size, f.duration),
        () => goPlay({ track: i }),
        i + 1,
        false,
      ),
    );
  };

  const hasList = chapters.length > 0 || files.length > 0;

  // --- Tabs ----------------------------------------------------------------
  // Everything after the overview lives in tabs: with a few hundred chapters the
  // old single scroll buried bookmarks/notes/metadata below an unreachable list.
  // The community-metadata tabs are progressive enhancement - absent entirely on
  // an older server or an unmatched book.
  const metaCharacters = metaMatched?.work.characters ?? [];
  const metaRecaps = metaMatched?.work.recaps ?? [];
  const metaSummary = metaMatched?.work.recap_summary;

  // Spoiler gating: ONE whole-book position - the player's live one when this book is
  // loaded, else the saved progress - mapped onto the chapter list (see meta-gating).
  // Reading a position rather than the player's chapter identity matters: a chapterless
  // single-file book gets synthetic 30-minute chapters whose indexes are wall-clock
  // slices, not logical chapters. The furthest of the two is used so a live position
  // that has not ticked yet can't briefly un-reveal what the saved one already showed.
  const listening = listeningProgressFor({
    chapterStarts,
    position: isThisPlaying ? Math.max(livePosition, progress?.position ?? 0) : progress?.position,
    finished: !!progress?.finished,
  });
  // Whether the whole-book summary will actually render - the same predicate the
  // Recaps panel guards on, so a tab can never open onto a panel that withholds
  // everything (an `ending` alone is withheld until the book is finished).
  const summaryVisible = summaryIsVisible(metaSummary, listening.finished);

  const tabs = bookTabs({
    // Chapters arrive on their own request; count the tab as present while it is in
    // flight (its panel is simply empty meanwhile) so the row doesn't briefly start on
    // Bookmarks - firing that GET - and then snap to Chapters when the data lands.
    hasList: hasList || chaptersLoading,
    hasRecaps: metaRecaps.length > 0,
    hasCharacters: metaCharacters.length > 0,
    hasSeries: rails.length > 0,
    hasPreviousBooks: previousBooks.length > 0,
    summaryVisible,
  });
  const activeTab = tabs.includes(tab) ? tab : tabs[0];
  // Chapters' label flips between "Chapters" and "Files"; every other tab reuses an
  // existing section string (see TAB_LABEL_KEY).
  const tabLabel = (v: BookTab): string => (v === 'chapters' ? listLabel : t(TAB_LABEL_KEY[v]));

  const tabContent = () => {
    switch (activeTab) {
      case 'chapters':
        // A plain View, NOT a Fragment: the rows carry their own `my-1` spacing, and a
        // Fragment would make each one a direct child of tabSection's `gap-4`.
        return <View>{renderRows()}</View>;
      case 'recaps':
        return (
          <BookMetaRecapsTab
            recaps={metaRecaps}
            progress={listening}
            summary={metaSummary}
            summaryVisible={summaryVisible}
            showSpoilers={showSpoilers}
            onToggleSpoilers={() => setShowSpoilers((v) => !v)}
            previousBooks={previousBooks}
          />
        );
      case 'characters':
        return (
          <BookMetaCharactersTab
            characters={metaCharacters}
            progress={listening}
            showSpoilers={showSpoilers}
            onToggleSpoilers={() => setShowSpoilers((v) => !v)}
            previousBooks={previousBooks}
          />
        );
      case 'bookmarks':
        return (
          <BookmarksSection
            libraryId={libraryId}
            path={path}
            emptyLabel={t('player.bookmarks.empty')}
          />
        );
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
    }
  };

  // The tab bar + the active panel, shared by both layouts. Rendered inside the
  // page's own vertical ScrollView (no nested vertical scrollers).
  const tabSection = (
    <View className="gap-4">
      <TabBar
        options={tabs.map((v) => ({ value: v, label: tabLabel(v) }))}
        value={activeTab}
        onChange={setTab}
      />
      {tabContent()}
    </View>
  );

  if (wide) {
    // The cover panel never carries a transport: the docked player bar does, so while
    // this book plays its button opens the full player instead of restarting it.
    return (
      <View className="flex-1 flex-row">
        <ScrollView className="flex-1" contentContainerClassName="gap-4 p-6 lg:p-8">
          <BreadCrumbs crumbs={crumbs} />
          <BookVersions book={book} connectionId={cid} />
          <DownloadControl
            libraryId={libraryId}
            path={path}
            book={book}
            chapterData={chapterData}
            disabled={chaptersLoading}
          />
          {metaMatched ? <BookMetaAbout meta={metaMatched} /> : null}
          {tabSection}
        </ScrollView>

        <View
          className={`overflow-hidden border-l border-border ${
            layout === 'desktop' ? 'w-[380px]' : 'w-[300px]'
          }`}
        >
          <View className="flex-1 items-center justify-center">
            <CoverBackdrop source={coverSource} />
            <View className="w-full items-center gap-6 p-6">
              <CoverFrame size="lg" className="aspect-square w-full max-w-[300px]">
                <Cover source={coverSource} label={book.title} sublabel={book.author} />
              </CoverFrame>
              <View className="items-center gap-1">
                {book.author ? (
                  <Text variant="muted" className="text-center opacity-80">
                    {t('book.byAuthor', { author: book.author })}
                  </Text>
                ) : null}
                <Text variant="title" className="text-center" numberOfLines={2}>
                  {book.title}
                </Text>
                {seriesLabel ? (
                  <Text variant="muted" className="text-center">
                    {seriesLabel}
                  </Text>
                ) : null}
              </View>
              <BookStats libraryId={libraryId} path={path} book={book} />
              {isThisPlaying ? (
                <Button
                  title={t('book.openPlayer')}
                  icon="chevron-up"
                  className="w-full"
                  onPress={() => router.push('/player')}
                />
              ) : (
                <Button
                  title={t('book.listen')}
                  icon="play"
                  className="w-full"
                  onPress={() => goPlay({})}
                />
              )}
              {book.narrator ? (
                <Text variant="muted" className="text-center">
                  {t('book.narratedBy', { narrator: book.narrator })}
                </Text>
              ) : null}
            </View>
          </View>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-6 p-4"
      contentContainerStyle={{ paddingBottom }}
    >
      <BreadCrumbs crumbs={crumbs} />

      <BookVersions book={book} connectionId={cid} />

      <View className="overflow-hidden rounded-2xl">
        <CoverBackdrop source={coverSource} />
        <View className="items-center gap-4 p-5">
          <CoverFrame size="lg" className="w-full max-w-[240px]">
            <Cover source={coverSource} label={book.title} sublabel={book.author} />
          </CoverFrame>
          <View className="w-full gap-1">
            {book.author ? (
              <Text variant="body" className="text-center opacity-80">
                {t('book.byAuthor', { author: book.author })}
              </Text>
            ) : null}
            <Text variant="heading" className="text-center">
              {book.title}
            </Text>
            {seriesLabel ? (
              <Text variant="muted" className="text-center">
                {seriesLabel}
              </Text>
            ) : null}
          </View>
          <BookStats libraryId={libraryId} path={path} book={book} />
        </View>
      </View>

      <View className="gap-3">
        <View className="flex-row gap-2">
          <Button
            title={t('book.listen')}
            icon="play"
            className="flex-1"
            onPress={() => goPlay({})}
          />
          <DownloadControl
            libraryId={libraryId}
            path={path}
            book={book}
            chapterData={chapterData}
            disabled={chaptersLoading}
            compact
          />
        </View>

        <DownloadProgress libraryId={libraryId} path={path} />

        {book.narrator ? (
          <Text variant="muted" className="text-center">
            {t('book.narratedBy', { narrator: book.narrator })}
          </Text>
        ) : null}
      </View>

      {metaMatched ? <BookMetaAbout meta={metaMatched} /> : null}

      {tabSection}
    </ScrollView>
  );
}
