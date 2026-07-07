import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useBook } from '@/api/hooks';
import { useCid, useOptionalApi } from '@/api/provider';
import type { FsEntry } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatCountdown } from '@/lib/format';
import { bookHref, libraryHref, parentPath, pathLeaf, playerHref } from '@/lib/paths';
import { resolveNextBook } from '@/playback/next-book';
import { selectBookPosition, usePlayer } from '@/playback/store';
import { useSettings } from '@/stores/settings';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

import { endCreditsDecision } from './end-credits-logic';

/**
 * The end-credits ("book finished") screen: shows the book that just finished, resolves
 * the next book in the folder/series, and offers Play next - with an optional auto-play
 * countdown driven by the `autoPlayNext` setting (see end-credits-logic). Kept as a
 * component (not a route file) so the route stays thin and this stays reusable; the
 * countdown/fire decision lives in the pure, tested end-credits-logic module.
 *
 * `auto` marks an arrival from the book's natural end. The finished book's metadata is
 * often wrong for audiobooks, so the folder name is always shown as a distinct line.
 */
export function EndCredits({
  connectionId,
  libraryId,
  path,
}: {
  connectionId: string;
  libraryId: number;
  path: string;
}) {
  const { t } = useTranslation();
  const { scheme } = useTheme();
  const neutral = scheme === 'dark' ? colors.dark.textStrong : colors.light.textStrong;
  const insets = useSafeAreaInsets();

  const cid = useCid(connectionId);
  const api = useOptionalApi(connectionId);
  const { data: book } = useBook(libraryId, path, connectionId);

  const autoPlayNext = useSettings((s) => s.autoPlayNext);

  // Is the finished book still loaded and actually playing? (Early arrival: the credits
  // audio is still running. After a natural end the listener clears nowPlaying, so this
  // is false.) Its remaining audio time drives the "still playing" countdown regime.
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const playbackState = usePlayer((s) => s.snapshot.state);
  const bookPosition = usePlayer(selectBookPosition);
  const isThisLoaded =
    nowPlaying?.connectionId === cid &&
    nowPlaying?.libraryId === libraryId &&
    nowPlaying?.path === path;
  const stillPlaying = isThisLoaded && (playbackState === 'playing' || playbackState === 'loading');
  const total = isThisLoaded ? nowPlaying.queue.total : 0;
  const remainingSeconds = Math.max(0, total - bookPosition);

  // Resolve the next book in the folder once. `undefined` = still resolving; `null` = none.
  const [nextBook, setNextBook] = useState<FsEntry | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!api) {
        setNextBook(null);
        return;
      }
      const n = await resolveNextBook(api, libraryId, path);
      if (!cancelled) setNextBook(n);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, libraryId, path]);

  const [cancelled, setCancelled] = useState(false);
  const hasNext = !!nextBook;

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

  // Fire at most once - Play next (manual) and the countdown share this.
  const fired = useRef(false);
  const playNext = useCallback(() => {
    if (fired.current || !nextBook) return;
    fired.current = true;
    // If the finished book is somehow still loaded (early arrival), finish it first:
    // finishBook persists finished, tears down the engine, clears nowPlaying and (when
    // enabled) deletes the downloaded copy. The player screen auto-plays the next book
    // on mount once its book + chapters load.
    if (usePlayer.getState().nowPlaying) usePlayer.getState().finishBook();
    router.replace(playerHref(cid, libraryId, nextBook.path));
  }, [nextBook, cid, libraryId]);

  useEffect(() => {
    if (decision.fireNext) playNext();
  }, [decision.fireNext, playNext]);

  const onClose = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(libraryHref(cid, libraryId, parentPath(path)));
  }, [cid, libraryId, path]);

  const folderName = pathLeaf(path);
  const cover = book ? api?.coverUrl(libraryId, path) : undefined;

  return (
    <View
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      className="flex-1 bg-gray-200 dark:bg-gray-800"
    >
      <View className="flex-row items-center px-4 py-2">
        <Pressable
          onPress={onClose}
          hitSlop={12}
          className="h-8 w-8 items-center justify-center"
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        >
          <Icon name="chevron-down" size={26} color={neutral} />
        </Pressable>
      </View>

      <ScrollView className="flex-1" contentContainerClassName="items-center gap-6 px-6 pb-10 pt-2">
        {/* The finished book. */}
        <View className="w-40">
          <Cover
            source={cover ? { uri: cover, headers: api?.authHeaders() } : null}
            label={book?.title ?? folderName}
            sublabel={book?.author}
          />
        </View>
        <View className="items-center gap-1">
          <Text variant="label" className="text-primary">
            {t('player.finished.heading')}
          </Text>
          <Text variant="heading" className="text-center" numberOfLines={2}>
            {book?.title ?? folderName}
          </Text>
          {book?.author ? (
            <Text variant="muted" className="text-center">
              {t('book.byAuthor', { author: book.author })}
            </Text>
          ) : null}
          {/* Metadata is often wrong for audiobooks, so surface the folder name plainly. */}
          <Text variant="caption" className="text-center" numberOfLines={1}>
            {folderName}
          </Text>
        </View>

        {/* Up next / end-of-folder. */}
        {nextBook ? (
          <View className="w-full max-w-[420px] gap-3 rounded-2xl bg-gray-100 p-4 dark:bg-gray-840">
            <Text variant="label">{t('player.finished.upNext')}</Text>
            <View className="gap-0.5">
              <Text variant="title" numberOfLines={2}>
                {nextBook.name}
              </Text>
              {nextBook.title && nextBook.title !== nextBook.name ? (
                <Text variant="muted" numberOfLines={1}>
                  {nextBook.title}
                </Text>
              ) : null}
              {nextBook.author ? (
                <Text variant="caption" numberOfLines={1}>
                  {t('book.byAuthor', { author: nextBook.author })}
                </Text>
              ) : null}
            </View>
            <Button title={t('player.finished.playNext')} icon="play" onPress={playNext} />
            {decision.showCountdown ? (
              <View className="flex-row items-center justify-center gap-3">
                <Text variant="muted">
                  {t('player.finished.startingIn', {
                    time: formatCountdown(decision.countdownSeconds),
                  })}
                </Text>
                <Pressable
                  onPress={() => setCancelled(true)}
                  hitSlop={8}
                  accessibilityRole="button"
                  className="active:opacity-60"
                >
                  <Text className="font-roboto-medium text-primary">{t('common.cancel')}</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : nextBook === null ? (
          <Text variant="muted" className="text-center">
            {t('player.finished.endOfSeries')}
          </Text>
        ) : null}

        {/* Secondary actions. */}
        <View className="w-full max-w-[420px] gap-2">
          <Button
            title={t('player.finished.viewDetails')}
            variant="secondary"
            icon="book"
            onPress={() => router.replace(bookHref(cid, libraryId, path))}
          />
          <Button title={t('common.done')} variant="ghost" onPress={onClose} />
        </View>
      </ScrollView>
    </View>
  );
}
