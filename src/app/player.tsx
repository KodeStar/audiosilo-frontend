import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useBook, useCapability, useChapters } from '@/api/hooks';
import { useCid } from '@/api/provider';
import { useRouteConnection } from '@/components/layout/content-scope';
import { PlayerView } from '@/components/player/player-view';
import { EpisodeFetchPanel } from '@/components/podcasts/episode-fetch-panel';
import { Spinner } from '@/components/ui/spinner';
import { contentKey } from '@/lib/content-key';
import { bookTitle, segmentsToPath } from '@/lib/paths';
import { usePageTitle } from '@/lib/use-page-title';
import {
  cancelEpisodeFetchUnless,
  needsEpisodeFetch,
  requestEpisodeFetch,
  useEpisodeFetch,
} from '@/playback/episode-fetch';
import { usePlayer } from '@/playback/store';

export default function PlayerScreen() {
  const {
    connection,
    libraryId: libParam,
    path: pathParam,
    position,
    track,
  } = useLocalSearchParams<{
    connection?: string;
    libraryId?: string;
    path?: string | string[];
    position?: string;
    track?: string;
  }>();
  // The route-connection rule (`useRouteConnection`): an old id (a widget's or Live
  // Activity's link) resolves; an unknown connection or another person's (Phase 8: switch
  // first, never start their book silently) shows its gate instead of the player.
  const { cid: param, gate } = useRouteConnection(connection);
  const gated = gate !== null;
  const connectionId = param || undefined;
  const libraryId = Number(libParam);
  const path = segmentsToPath(pathParam);
  // The player is a root modal (outside any route scope), so the connection it plays
  // rides in as a param; fall back to the active connection when opened bare (the
  // mini-player just re-shows nowPlaying).
  const cid = useCid(connectionId);
  const insets = useSafeAreaInsets();

  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const seekBook = usePlayer((s) => s.seekBook);
  const goToTrack = usePlayer((s) => s.goToTrack);

  const { data: book } = useBook(libraryId, path, connectionId);
  // Opened bare (the mini player, the docked bar, the palette) there is no route book:
  // the book on screen is the one loaded.
  usePageTitle(
    book
      ? bookTitle(book.title, path)
      : nowPlaying
        ? bookTitle(nowPlaying.title, nowPlaying.path)
        : undefined,
  );
  const chaptersQuery = useChapters(libraryId, path, connectionId);
  const chapterData = chaptersQuery.data;
  // An episode not on its server yet starts through the fetch (`episode-fetch.ts`), and
  // the fetch shows here in place of the player until it starts (Bridge Phase 2d-1).
  const podcastFetch = useCapability('podcast_fetch', cid);
  const pendingFetch = useEpisodeFetch((s) => s.pending);
  const routeKey = book ? contentKey(cid, libraryId, book.rel_path) : null;

  // Auto-start playback AT MOST ONCE per target book. A mount-scoped latch keyed by
  // `${cid}|${libraryId}|<rel_path>` remembers the target we already resolved, so we never
  // re-start it just because `nowPlaying` changed underneath us. This guards the
  // end-of-book teardown: finishBook() clears `nowPlaying` and THEN navigates away, so
  // between those two steps this effect re-runs with `nowPlaying === null` - the
  // "already playing" guard below stops matching and, without the latch, we'd fall through
  // and restart the just-finished book (audio playing under the end-credits screen). A
  // different key (the route reused for another book) naturally differs, so a genuine new
  // target still starts. The end of a book is not such a target: the credits start the
  // next book in place (`advanceTo`) and only then show it here, already playing.
  const startedKeyRef = useRef<string | null>(null);
  // The route's jump (`?position=` / `?track=`: a chapter, file, bookmark or history tap)
  // is applied ONCE per book and params, remembered here as `${key}|position|track`. The
  // effect below re-runs whenever `nowPlaying` is replaced, and that happens for the
  // SAME book while the player is open: the hot-swap to the downloaded copy when the
  // book's download lands mid-listen. Jumping again then threw the listener back to the
  // tapped place and saved that older place over the real one. A navigation with other
  // params is a new jump.
  const jumpedKeyRef = useRef<string | null>(null);
  // Start playback once the book AND its chapters/files have loaded - otherwise
  // multi-file/folder books would fall back to streaming the folder path and
  // chapters would be missing. Start point priority: explicit position (bookmark
  // jump) > resume. If this book is already playing, only honor an explicit jump.
  useEffect(() => {
    // Not while the gate shows: the store would refuse the start anyway (`mayActFor`), but
    // the latch below must not record a start that never happened, or the book would not
    // start once the listener switched.
    if (gated || !book || Number.isNaN(libraryId) || chaptersQuery.isLoading) return;
    const posParam = position !== undefined ? Number(position) : undefined;
    const hasPos = posParam !== undefined && !Number.isNaN(posParam);
    const trackParam = track !== undefined ? Number(track) : undefined;
    const hasTrack = trackParam !== undefined && !Number.isNaN(trackParam);
    // Keyed on the book's canonical rel_path (playBook stores that as nowPlaying.path,
    // which can differ from the decoded route param).
    const key = `${cid}|${libraryId}|${book.rel_path}`;
    const jumpKey = `${key}|${position ?? ''}|${track ?? ''}`;
    // Compare against the book's canonical rel_path - playBook stores that as
    // nowPlaying.path, which can differ from the decoded route param. Using the
    // route param here made the guard never match for some paths, re-invoking
    // playBook every render (hammering getProgress + restarting playback).
    if (
      nowPlaying?.connectionId === cid &&
      nowPlaying?.libraryId === libraryId &&
      nowPlaying?.path === book.rel_path
    ) {
      startedKeyRef.current = key; // this target is handled; don't auto-start it again
      if (jumpedKeyRef.current === jumpKey) return; // this jump is already done
      jumpedKeyRef.current = jumpKey;
      if (hasPos) void seekBook(posParam);
      else if (hasTrack) void goToTrack(trackParam);
      return;
    }
    // Already auto-started this exact target (nowPlaying has since been cleared, e.g. by
    // the finishBook teardown) - do NOT restart it just because the guard above no longer
    // matches. A new target (different key) falls through and starts.
    if (startedKeyRef.current === key) return;
    // An episode not on its server: wait for the server's flags before choosing a start,
    // so it never streams a file that isn't there yet.
    const absentEpisode = !!book.episode && !book.episode.downloaded;
    if (absentEpisode && podcastFetch === undefined) return;
    startedKeyRef.current = key;
    // The start below lands on the jump itself, so the book showing up as `nowPlaying`
    // must not jump there a second time.
    jumpedKeyRef.current = jumpKey;
    const startAt = hasPos ? posParam : undefined;
    if (needsEpisodeFetch(book, podcastFetch)) {
      requestEpisodeFetch({ connectionId: cid, libraryId, path: book.rel_path }, book, {
        position: startAt,
        track: hasTrack ? trackParam : undefined,
      });
      return;
    }
    cancelEpisodeFetchUnless(contentKey(cid, libraryId, book.rel_path));
    void usePlayer
      .getState()
      .playBook(cid, libraryId, book, chapterData, startAt, hasTrack ? trackParam : undefined);
  }, [
    cid,
    book,
    chapterData,
    chaptersQuery.isLoading,
    libraryId,
    path,
    position,
    track,
    nowPlaying,
    seekBook,
    goToTrack,
    gated,
    podcastFetch,
  ]);

  if (gate) return gate;

  if (!book && !nowPlaying) {
    return (
      <View
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
        className="flex-1 bg-background"
      >
        <Spinner center />
      </View>
    );
  }

  if (pendingFetch && pendingFetch.key === routeKey) {
    return (
      <View className="flex-1 bg-background">
        <EpisodeFetchPanel onClose={() => router.back()} />
      </View>
    );
  }

  return (
    // No safe-area padding here: the atmospheric backdrop must paint edge-to-edge
    // under the status bar / notch. PlayerView pads its own top controls + footer
    // down by the insets instead (so nothing sits under the status bar).
    <View className="flex-1 bg-background">
      {/* Opened from the mini player (phone) or the docked bar's expand button
          (tablet/desktop); PlayerView renders the close button in its toolbar. */}
      <PlayerView onClose={() => router.back()} />
    </View>
  );
}
