import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CapabilityError,
  qk,
  useAllProgressAll,
  useBook,
  useBookMeta,
  useBookProgress,
  useCapability,
  useMyStats,
  useRating,
  useSetRating,
} from '@/api/hooks';
import { ConnectionScope, useCid, useOptionalApi } from '@/api/provider';
import type { RatingValue } from '@/api/types';
import { BookCover } from '@/components/library/book-cover';
import { matchedMeta } from '@/components/library/book-meta';
import { CoverWash } from '@/components/library/cover-wash';
import { CoverBackdrop } from '@/components/player/cover-backdrop';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { formatDuration, formatSpeed } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { bookHref, bookTitle, libraryHref, parentPath, playerHref } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { whenActive } from '@/lib/when-active';
import { selectBookPosition, usePlayer } from '@/playback/store';
import { resolveUpNext, type UpNextAnswer } from '@/playback/up-next-resolver';
import { upNextSources } from '@/playback/up-next-sources';
import { useSettings } from '@/stores/settings';

import {
  endCreditsDecision,
  HISTORY_LIMIT,
  listeningSummary,
  yearShelf,
} from './end-credits-logic';
import {
  CreditsDialog,
  EndOfSeries,
  StatTile,
  UpNextCard,
  UpNextSkeleton,
  YearShelf,
  type ShelfBook,
} from './end-credits-parts';
import { RatingStars } from './rating-stars';
import { startBookInPlace } from './start-book';
import { useQueueDrop } from './use-queue-drop';

/** Spines on the year shelf at most (the oldest go first when the row is narrower). */
const SHELF_MAX = { phone: 9, wide: 14 };

/**
 * The end-credits ("book finished") screen, the `/finished` root modal: the finished
 * book on the year shelf, its listening, a rating, and the book that plays next with
 * the auto-play countdown (`end-credits-logic`). What plays next is `resolveUpNext`, the
 * same answer the background auto-play gives: the Up next queue first, then the series.
 * Its hooks run against the book's own server (`ConnectionScope`).
 *
 * The full player's "View credits" opens it for a book still playing: then the
 * countdown follows the remaining audio and nothing starts before the book ends.
 */
export function EndCredits({
  connectionId,
  libraryId,
  path,
  ended = false,
}: {
  connectionId: string;
  libraryId: number;
  path: string;
  /** Opened by the book's natural end (`auto=1`), so it is finished. */
  ended?: boolean;
}) {
  const cid = useCid(connectionId);
  return (
    <ConnectionScope connectionId={cid}>
      <EndCreditsBody cid={cid} libraryId={libraryId} path={path} ended={ended} />
    </ConnectionScope>
  );
}

function EndCreditsBody({
  cid,
  libraryId,
  path,
  ended,
}: {
  cid: string;
  libraryId: number;
  path: string;
  ended: boolean;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const phone = useLayout() === 'phone';
  const api = useOptionalApi(cid);
  const { data: book } = useBook(libraryId, path, cid);
  const title = bookTitle(book?.title, path);

  const autoPlayNext = useSettings((s) => s.autoPlayNext);

  // Is the finished book still loaded and actually playing? (Early arrival: the credits
  // audio is still running. After a natural end the listener clears nowPlaying, so this
  // is false.) Its remaining audio time drives the "still playing" countdown regime.
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const playbackState = usePlayer((s) => s.snapshot.state);
  const bookPosition = usePlayer(selectBookPosition);
  const rate = usePlayer((s) => s.rate);
  const isThisLoaded =
    nowPlaying?.connectionId === cid &&
    nowPlaying?.libraryId === libraryId &&
    nowPlaying?.path === path;
  // "Still here" = the finished book is still loaded and has NOT reached its natural end -
  // this covers playing, buffering, AND a paused/errored book. Only a book that is genuinely
  // over (unloaded by the natural-end teardown, or sitting in the terminal `ended` state)
  // hands over to the grace countdown. Keying this on playing/loading alone let a lock-screen
  // pause of an early-opened credits screen read as "over" and auto-advance mid-listen,
  // force-finishing the half-heard book (and deleting its download).
  const stillPlaying = isThisLoaded && playbackState !== 'ended';
  const total = isThisLoaded ? nowPlaying.queue.total : 0;
  const remainingSeconds = Math.max(0, total - bookPosition);

  // What plays next, worked out once. `undefined` while resolving.
  const [answer, setAnswer] = useState<UpNextAnswer | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const a = api
        ? await resolveUpNext(upNextSources(api, cid), { connectionId: cid, libraryId, path })
        : { next: null };
      if (!cancelled) setAnswer(a);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, cid, libraryId, path]);
  const next = answer?.next ?? null;

  const [cancelled, setCancelled] = useState(false);
  const hasNext = !!next;

  // The grace countdown runs only once the book is over (not stillPlaying). The interval
  // callback (async setState, so no synchronous setState-in-effect) advances the elapsed
  // time; it starts fresh from 0 because the grace phase activates at most once per visit
  // (auto arrival, or stillPlaying flipping false - during which the interval never ran).
  const [elapsedGrace, setElapsedGrace] = useState(0);
  const graceActive = autoPlayNext && hasNext && !cancelled && !stillPlaying;
  useEffect(() => {
    if (!graceActive) return;
    const start = Date.now();
    const id = setInterval(() => setElapsedGrace((Date.now() - start) / 1000), 500);
    return () => clearInterval(id);
  }, [graceActive]);

  const decision = endCreditsDecision({
    autoPlayNext,
    hasNext,
    stillPlaying,
    remainingSeconds,
    cancelled,
    elapsedGrace,
  });

  // Fire at most once - Play now (manual) and the countdown share this.
  const dropFromQueue = useQueueDrop(cid);
  const fired = useRef(false);
  const playNext = useCallback(() => {
    if (fired.current || !next) return;
    fired.current = true;
    // If the finished book is still loaded (early arrival), finish it first: finishBook
    // persists finished, tears down the engine, clears nowPlaying and (when enabled)
    // deletes the downloaded copy. The player screen plays the next book on mount once
    // its book + chapters load.
    const { nowPlaying: np, finishBook } = usePlayer.getState();
    const finishing = np?.connectionId === cid && np.libraryId === libraryId && np.path === path;
    if (finishing) finishBook();
    const href = playerHref(next.connectionId, next.libraryId, next.path);
    if (AppState.currentState === 'active') router.replace(href);
    else {
      // The countdown ran out with the app in the background: start the book in place
      // (a modal can't be presented from the background; the app came back black) and
      // swap the credits for the player once the app is back (after the start settled).
      // The player route sees the book already playing and leaves it be; if the start
      // failed it starts the book itself.
      void startBookInPlace(next)
        .catch((err: unknown) => console.warn('[end-of-book] could not start the next book', err))
        .finally(() => whenActive(() => router.replace(href)));
    }
    // The queued book is now the book you're on; a book finished here leaves Up next too
    // (a natural end already took it off).
    const leaving = [
      ...(next.queueEntry ? [next.queueEntry] : []),
      ...(finishing ? [{ library_id: libraryId, path }] : []),
    ];
    if (leaving.length > 0) void dropFromQueue(leaving);
  }, [next, cid, libraryId, path, dropFromQueue]);

  useEffect(() => {
    if (decision.fireNext) playNext();
  }, [decision.fireNext, playNext]);

  // Opened by the book's end (or "Mark as finished"): it is no longer up next. Once.
  const dropped = useRef(false);
  useEffect(() => {
    if (!ended || dropped.current) return;
    dropped.current = true;
    void dropFromQueue([{ library_id: libraryId, path }]);
  }, [ended, dropFromQueue, libraryId, path]);

  const onClose = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(libraryHref(cid, libraryId, parentPath(path)));
  }, [cid, libraryId, path]);

  // --- What the credits show -------------------------------------------------------
  const [creditsOpen, setCreditsOpen] = useState(false);
  const metaEnabled =
    useCapability('metadata', cid) === true && !!(book?.asin || book?.isbn) && creditsOpen;
  const { data: meta } = useBookMeta(libraryId, path, metaEnabled);
  const matched = matchedMeta(meta, metaEnabled);

  const history = useQuery({
    queryKey: [...qk.history(cid, libraryId, path), HISTORY_LIMIT],
    queryFn: () => api!.history(libraryId, path, HISTORY_LIMIT),
    enabled: !!api && path.length > 0,
  });
  const listened = history.data ? listeningSummary(history.data) : null;
  const { data: saved } = useBookProgress(libraryId, path, true, cid);
  const speed = isThisLoaded ? rate : saved?.playback_speed || rate;
  // Finished: it ended here, or its saved progress says so (the credits can also be
  // opened for a book still playing, or reopened later without it loaded).
  const finished = !stillPlaying && (ended || !!saved?.finished);

  const statsCap = useCapability('user_stats', cid);
  const stats = useMyStats('year', cid);
  const { progress: allProgress } = useAllProgressAll({ refetchOnMount: false });
  const shelf = useMemo(() => {
    if (!stats.data) return null;
    const { others, bookNumber } = yearShelf(
      stats.data,
      { libraryId, path },
      finished,
      phone ? SHELF_MAX.phone : SHELF_MAX.wide,
    );
    const seconds = new Map(
      allProgress
        .filter((p) => p.connectionId === cid)
        .map((p) => [`${p.library_id}:${p.path}`, p.duration]),
    );
    const books: ShelfBook[] = others.map((b) => ({
      key: `${b.library_id}:${b.path}`,
      title: bookTitle(b.title, b.path),
      author: b.author,
      seconds: seconds.get(`${b.library_id}:${b.path}`),
    }));
    return { books, bookNumber, count: bookNumber ?? stats.data.totals.finished };
  }, [stats.data, libraryId, path, finished, phone, allProgress, cid]);

  const ratingsCap = useCapability('ratings', cid) === true;
  const rating = useRating(libraryId, path, cid);
  const setRating = useSetRating(cid);
  const [picked, setPicked] = useState<RatingValue | undefined>(undefined);
  const onRate = (value: RatingValue) => {
    setPicked(value);
    // A PUT replaces the whole rating: carry the saved note so rating doesn't clear it.
    setRating.mutateAsync({ libraryId, path, rating: value, note: rating.data?.note }).then(
      () => toast({ title: t('player.finished.ratingSaved') }),
      (e: unknown) => {
        setPicked(undefined);
        if (!(e instanceof CapabilityError)) toast({ title: t('player.finished.ratingFailed') });
      },
    );
  };

  // --- Layout ----------------------------------------------------------------------------
  const shelfOrCover =
    statsCap && stats.isLoading ? (
      // Holding the shelf's room while the year's books load, so nothing jumps.
      <View style={{ height: phone ? 140 : 168 }} />
    ) : shelf && shelf.books.length > 0 ? (
      <YearShelf
        others={shelf.books}
        current={{
          key: `${libraryId}:${path}`,
          title,
          author: book?.author,
          seconds: book?.duration,
          coverColor: book?.cover_color,
        }}
        phone={phone}
        count={shelf.count}
      />
    ) : (
      <BookCover
        connectionId={cid}
        libraryId={libraryId}
        path={path}
        coverVersion={book?.cover_version}
        width={phone ? 160 : 200}
        title={title}
        author={book?.author}
        shadow="lg"
      />
    );

  const byline =
    book?.author && book.narrator
      ? t('player.finished.byline', { author: book.author, narrator: book.narrator })
      : book?.narrator
        ? t('player.finished.readByOnly', { narrator: book.narrator })
        : (book?.author ?? '');

  const tiles: [string, string][] = [];
  if (listened && listened.seconds > 0)
    tiles.push([
      t('player.finished.timeListened'),
      `${formatDuration(listened.seconds)}${listened.partial ? '+' : ''}`,
    ]);
  if (listened && listened.days > 0)
    tiles.push([
      t('player.finished.across'),
      `${t('player.finished.days', { count: listened.days })}${listened.partial ? '+' : ''}`,
    ]);
  if (speed > 0) tiles.push([t('player.finished.yourSpeed'), formatSpeed(speed)]);

  return (
    <View
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      className="flex-1 bg-background"
    >
      {/* The finished book's colours behind everything (text stays on the page tokens);
          the blurred art where the server sends no colour. */}
      {book?.cover_color ? (
        <CoverWash color={book.cover_color} variant="hero" />
      ) : (
        <FallbackBackdrop cid={cid} libraryId={libraryId} path={path} hasBook={!!book} />
      )}

      <View className={cn('flex-row items-center gap-2 py-2', phone ? 'px-2' : 'px-4')}>
        <Button
          variant="ghost"
          size="icon"
          icon="close"
          accessibilityLabel={t('common.close')}
          onPress={onClose}
        />
        <Text variant="eyebrow" className="flex-1 text-center" accessibilityRole="header">
          {t('player.finished.eyebrow')}
        </Text>
        <Button
          variant="ghost"
          size="sm"
          title={t('player.finished.credits')}
          onPress={() => setCreditsOpen(true)}
        />
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName={cn(
          'items-center gap-6',
          phone ? 'px-5 pb-8 pt-1.5' : 'px-10 pb-10 pt-2.5',
        )}
      >
        {shelfOrCover}

        <View className="w-full max-w-[720px] items-center gap-1.5">
          {shelf?.bookNumber ? (
            <Text variant="eyebrow" className="text-center">
              {t('player.finished.bookOfYear', { number: shelf.bookNumber })}
            </Text>
          ) : null}
          <Text
            variant="display-xl"
            className={cn(
              'text-center',
              phone ? 'text-[34px] leading-[38px]' : 'text-[50px] leading-[54px]',
            )}
            numberOfLines={3}
          >
            {title}
          </Text>
          {byline ? (
            <Text variant="muted" className="text-center">
              {byline}
            </Text>
          ) : null}
        </View>

        {tiles.length > 0 ? (
          <View className="w-full max-w-[720px] flex-row justify-center gap-3">
            {tiles.map(([label, value]) => (
              <StatTile key={label} label={label} value={value} phone={phone} />
            ))}
          </View>
        ) : null}

        {ratingsCap ? (
          <View className="items-center gap-1">
            <Text variant="label">{t('player.finished.howWasIt')}</Text>
            <RatingStars
              value={picked ?? rating.data?.rating}
              onRate={onRate}
              disabled={setRating.isPending}
            />
          </View>
        ) : null}

        {next ? (
          <UpNextCard
            next={next}
            decision={decision}
            stillPlaying={stillPlaying}
            phone={phone}
            onPlay={playNext}
            onNotNow={() => setCancelled(true)}
          />
        ) : answer ? (
          <EndOfSeries series={book?.series || undefined} unplaced={answer.unplaced} />
        ) : (
          <UpNextSkeleton />
        )}

        <Button
          variant="outline"
          icon="book-open"
          title={t('player.finished.details')}
          onPress={() => router.replace(bookHref(cid, libraryId, path))}
        />
      </ScrollView>

      <CreditsDialog
        open={creditsOpen}
        onOpenChange={setCreditsOpen}
        data={{
          title,
          author: book?.author,
          narrator: book?.narrator,
          recording: matched?.recording,
          released: book?.published || matched?.recording?.release_date || undefined,
          attribution: matched?.work.attribution,
          path,
        }}
      />
    </View>
  );
}

/** The finished book's blurred art behind the screen, for a server that sends no cover
 * colour (the look before cover colours). */
function FallbackBackdrop({
  cid,
  libraryId,
  path,
  hasBook,
}: {
  cid: string;
  libraryId: number;
  path: string;
  hasBook: boolean;
}) {
  const api = useOptionalApi(cid);
  const cover = hasBook ? api?.coverUrl(libraryId, path) : undefined;
  // Memoized: the countdown re-renders the screen every tick, and a new source object
  // each time would defeat expo-image's cache.
  const source = useMemo(
    () => (cover ? { uri: cover, headers: api?.authHeaders() } : null),
    [cover, api],
  );
  return <CoverBackdrop source={source} />;
}
