import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import {
  useBook,
  useBookProgress,
  useCapability,
  useChapters,
  usePodcastFetchStatus,
  usePodcastShows,
} from '@/api/hooks';
import { useScopedCid } from '@/api/provider';
import type { Book, PodcastEpisodeInfo } from '@/api/types';
import { BookChaptersTab } from '@/components/book/book-chapters-tab';
import {
  bookPageLayout,
  type ChapterList,
  chapterList,
  type Jump,
  knownChaptersSource,
  rowAt,
} from '@/components/book/book-page-model';
import { BookSkeleton } from '@/components/book/book-skeleton';
import { SignInAgainState, useSignedOutConnection } from '@/components/layout/sign-in-again';
import { BookCover } from '@/components/library/book-cover';
import { pageGutter } from '@/components/library/cover-layout';
import { chapterStartsOf, LIVE_POSITION_BUCKET_S } from '@/components/library/meta-gating';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { selectIsLoaded } from '@/components/player/playing-target';
import { useBookPlace } from '@/components/player/use-listening-position';
import { type PlayOptions, usePlayBook } from '@/components/player/use-play-book';
import { useBookAnnotations } from '@/components/player/use-playing-pins';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { ErrorNote } from '@/components/ui/query-state';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { contentKey } from '@/lib/content-key';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { bookTitle, pathLeaf } from '@/lib/paths';
import { useLatest } from '@/lib/use-latest';
import { usePageTitle } from '@/lib/use-page-title';
import { requestEpisodeFetch, useEpisodeFetch } from '@/playback/episode-fetch';
import { selectIsTransportLive, usePlayer } from '@/playback/store';
import { useSettings } from '@/stores/settings';

import {
  canRetryFetch,
  episodeMarks,
  episodeMetaLine,
  episodeRowState,
  rowStateReasonKey,
} from './podcast-model';

const NO_LIST: ChapterList = { kind: 'chapters', rows: [] };

/**
 * An episode's page (Bridge Phase 2d-1): what the book page shows for an item that is a
 * podcast episode (`book.episode`), at the same `/book` link, so Continue listening, the
 * Now card, history and favourites reach it as any book. Its cover, title, a link to its
 * show, its date, length and marks; Play / Resume (Pause while it plays), or Try again
 * after a failed fetch (`canRetryFetch`); a note when its audio changed under a saved place (never moved);
 * the description; and the chapters an episode's own file carries. No series, community
 * metadata, rating, Generate or Download.
 */
export function EpisodePage({ libraryId, path }: { libraryId: number; path: string }) {
  const { t } = useTranslation();
  const cid = useScopedCid();
  const { data: book, isLoading, refetch } = useBook(libraryId, path);
  const signedOut = useSignedOutConnection(cid);
  usePageTitle(book ? bookTitle(book.title, path) : undefined);
  const paddingBottom = useMiniPlayerInset();
  const layout = useLayout();

  if (isLoading) {
    return (
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom }}>
        <BookSkeleton layout={bookPageLayout(layout, 0)} />
      </ScrollView>
    );
  }
  if (!book) {
    return (
      <View className="flex-1 p-4">
        {signedOut ? (
          <SignInAgainState connection={signedOut} />
        ) : (
          <ErrorNote message={t('book.loadError')} onRetry={() => refetch()} />
        )}
      </View>
    );
  }
  if (!book.episode) return null;
  return (
    <EpisodeBody
      connectionId={cid}
      libraryId={libraryId}
      path={path}
      book={book}
      episode={book.episode}
    />
  );
}

function EpisodeBody({
  connectionId: cid,
  libraryId,
  path,
  book,
  episode,
}: {
  connectionId: string;
  libraryId: number;
  path: string;
  book: Book;
  episode: PodcastEpisodeInfo;
}) {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const gutter = pageGutter(useLayout());
  const paddingBottom = useMiniPlayerInset();
  const { openPodcastShow } = useOpen();
  const relPath = book.rel_path;
  const target = useMemo(
    () => ({ connectionId: cid, libraryId, path: relPath }),
    [cid, libraryId, relPath],
  );
  const { data: chapterData, isLoading: chaptersLoading } = useChapters(libraryId, path);
  const progress = useBookProgress(libraryId, path, true).data ?? undefined;
  const shows = usePodcastShows(libraryId, cid);
  const showTitle =
    shows.data?.find((s) => s.path === episode.show_path)?.title || pathLeaf(episode.show_path);
  const canFetch = useCapability('podcast_fetch', cid);
  const fetchStatus = usePodcastFetchStatus(libraryId, relPath, cid, {
    enabled: !episode.downloaded,
  }).data;
  const pending = useEpisodeFetch((s) =>
    s.pending?.key === contentKey(cid, libraryId, relPath) ? s.pending : null,
  );
  const loaded = usePlayer(selectIsLoaded(target));
  const live = usePlayer((s) => loaded && selectIsTransportLive(s));
  const { resume } = useBookPlace(target, progress?.position, LIVE_POSITION_BUCKET_S);
  const annotations = useBookAnnotations(target);
  const interval = useSettings((s) => s.virtualChapterInterval);
  const [width, setWidth] = useState(0);

  const playBook = usePlayBook();
  const play = (opts: PlayOptions) =>
    void playBook(target, opts).catch(() => toast({ title: t('library.bookActions.playFailed') }));
  const onJump = useLatest((jump: Jump) => play({ at: jump }));

  const chapters = useMemo(() => chapterData?.chapters ?? [], [chapterData]);
  const files = useMemo(() => chapterData?.files ?? [], [chapterData]);
  const chapterStarts = useMemo(() => chapterStartsOf(chapters, files), [chapters, files]);
  const total = chapterData?.duration || book.duration || 0;
  const list = useMemo(
    () =>
      chapterData
        ? chapterList({ chapters, files, chapterStarts, total, interval, bookPath: relPath })
        : NO_LIST,
    [chapterData, chapters, files, chapterStarts, total, interval, relPath],
  );

  const finished = !!progress?.finished && !loaded;
  const started = loaded || (!finished && (progress?.position ?? 0) > 0);
  const position = finished ? total : (resume ?? 0);
  const current = started && !finished ? rowAt(list.rows, position) : -1;
  const state = episodeRowState(
    { downloaded: episode.downloaded, fetch: fetchStatus ?? episode.fetch },
    pending,
    canFetch,
  );
  const meta = episodeMetaLine(
    {
      published: episode.published,
      duration: book.duration,
      duration_source: episode.duration_source,
      season: episode.season,
      episode: episode.episode,
    },
    t,
    new Date(),
  );
  const marks = episodeMarks(episode, t);
  // Why it can't play (or wasn't fetched), beside the disabled Play or Try again.
  const reasonKey = loaded ? null : rowStateReasonKey(state);
  const reason = reasonKey ? t(reasonKey) : null;

  const primary =
    canRetryFetch(state) && !loaded ? (
      <Button
        size="lg"
        icon="rotate"
        title={t('podcasts.episode.tryAgain')}
        onPress={() => requestEpisodeFetch(target, book, {}, { retry: true })}
        testID="episode-page-retry"
      />
    ) : (
      <Button
        size="lg"
        icon={loaded && live ? 'pause' : 'play'}
        title={
          loaded && live
            ? t('book.hero.pause')
            : started
              ? t('podcasts.episode.resume')
              : t('podcasts.episode.play')
        }
        disabled={state.kind === 'unavailable' && !loaded}
        onPress={() => play({ toggle: true, viaBookPage: true })}
        testID="episode-page-play"
      />
    );

  return (
    <ScrollView
      className="flex-1"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: 20, paddingBottom }}
    >
      <View testID="episode-page" className="w-full max-w-[880px] gap-6 self-center">
        <View className={phone ? 'items-center gap-4' : 'flex-row items-end gap-6'}>
          <BookCover
            connectionId={cid}
            libraryId={libraryId}
            path={relPath}
            coverVersion={book.cover_version}
            width={phone ? 200 : 220}
            title={book.title}
            author={book.author}
            shadow="lg"
          />
          <View className={phone ? 'items-center gap-2' : 'min-w-0 flex-1 gap-2'}>
            <Button
              variant="link"
              title={showTitle}
              onPress={() => openPodcastShow(cid, libraryId, episode.show_path)}
              className={phone ? 'self-center' : 'self-start'}
              testID="episode-show-link"
            />
            <Text variant="display" className={phone ? 'text-center' : undefined}>
              {bookTitle(book.title, relPath)}
            </Text>
            {meta ? <Text variant="muted">{meta}</Text> : null}
            {marks.length > 0 ? (
              <View className="flex-row flex-wrap gap-1.5">
                {marks.map((m) => (
                  <Badge key={m} variant="outline">
                    <Text>{m}</Text>
                  </Badge>
                ))}
              </View>
            ) : null}
            <View
              className={
                phone ? 'items-center gap-2 pt-2' : 'flex-row flex-wrap items-center gap-3 pt-2'
              }
            >
              {primary}
              {reason ? (
                <Text
                  variant="caption"
                  className={phone ? 'text-center' : 'min-w-0 flex-1'}
                  testID="episode-page-reason"
                >
                  {reason}
                </Text>
              ) : null}
            </View>
          </View>
        </View>
        {episode.timeline_changed === true && (progress?.position ?? 0) > 0 ? (
          <Notice
            icon="circle-info"
            tone="warning"
            title={t('podcasts.episode.timelineChangedTitle')}
            body={t('podcasts.episode.timelineChanged')}
            testID="episode-timeline-changed"
          />
        ) : null}
        {book.description ? <Text variant="body">{book.description}</Text> : null}
        {list.rows.length > 0 || chaptersLoading ? (
          <BookChaptersTab
            list={list}
            total={total}
            position={position}
            current={current}
            finished={finished}
            loaded={loaded}
            pins={annotations.pins}
            roomy={width >= 600}
            interval={interval}
            source={knownChaptersSource(book.chapters_source)}
            episode
            onJump={onJump}
          />
        ) : null}
      </View>
    </ScrollView>
  );
}
