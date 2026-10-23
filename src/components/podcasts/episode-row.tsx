import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import type { PodcastEpisode, PodcastShow, Progress } from '@/api/types';
import { BookActionsButton } from '@/components/library/books/book-actions';
import { usePlayBook } from '@/components/player/use-play-book';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { ProgressBar } from '@/components/ui/progress-bar';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { contentKey } from '@/lib/content-key';
import { useOpen } from '@/lib/open';
import { isInProgress, progressFractionRemaining } from '@/lib/progress-view';
import { cn } from '@/lib/utils';
import { requestEpisodeFetch, useEpisodeFetch } from '@/playback/episode-fetch';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import {
  canRetryFetch,
  episodeAsBook,
  episodeMarks,
  episodeMetaLine,
  type EpisodeRowState,
  episodeRowState,
  rowStateReasonKey,
} from './podcast-model';

/** The state line's words. */
function stateText(state: EpisodeRowState, t: TFunction): string {
  switch (state.kind) {
    case 'ready':
      return t('podcasts.episode.ready');
    case 'onDemand':
      return t('podcasts.episode.onDemand');
    case 'getting':
      return state.percent !== null
        ? t('podcasts.episode.gettingPercent', { percent: state.percent })
        : t('podcasts.episode.getting');
    case 'failed':
      return t('podcasts.episode.failed');
    case 'unavailable':
      return t('podcasts.episode.unavailable');
  }
}

/**
 * One episode of a show (Bridge Phase 2d-1): its title, a meta line (date, length, number),
 * its Trailer / Bonus / Explicit marks, a line saying where its file is (on the server,
 * fetched when played, on its way, or why not), and the listener's place (a bar while in
 * progress, a tick once finished). One primary button: Play (Resume once started), or Try
 * again after a failed fetch (or one not available for no reason it can name: `canRetryFetch`). Its "..." offers Up next and Mark as finished (never a
 * download: episodes are not kept offline). The row opens the episode page.
 */
export function EpisodeRow({
  connectionId,
  show,
  episode,
  progress,
  canFetch,
  now,
}: {
  connectionId: string;
  show: PodcastShow;
  episode: PodcastEpisode;
  progress?: Progress;
  canFetch: boolean | undefined;
  now: Date;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const { openBook } = useOpen();
  const playBook = usePlayBook();
  const libraryId = show.library_id;
  const target = { connectionId, libraryId, path: episode.path };
  const book = episodeAsBook(episode, show);
  // The player's fetch of this episode, when it is the one on its way (only this row
  // follows its progress).
  const key = contentKey(connectionId, libraryId, episode.path);
  const pending = useEpisodeFetch((s) => (s.pending?.key === key ? s.pending : null));
  const state = episodeRowState(episode, pending, canFetch);
  const finished = !!progress?.finished;
  // Why it can't play or wasn't fetched, also on a finished episode (else a disabled Play
  // there says nothing).
  const reasonKey = rowStateReasonKey(state);
  const retryable = canRetryFetch(state);
  const reason = reasonKey ? t(reasonKey) : null;
  const started = !!progress && isInProgress(progress);
  const fraction =
    progress && !finished && progress.position > 0
      ? progressFractionRemaining(progress.position, progress.duration || episode.duration).fraction
      : 0;
  const meta = episodeMetaLine(episode, t, now);
  const marks = episodeMarks(episode, t);

  const play = () =>
    void playBook(target).catch(() => toast({ title: t('library.bookActions.playFailed') }));
  const retry = () => requestEpisodeFetch(target, book, {}, { retry: true });

  return (
    <View testID="episode-row" className="flex-row items-center gap-2 border-b border-border py-3">
      <AnimatedPressable
        onPress={() => openBook(connectionId, libraryId, episode.path)}
        accessibilityRole="button"
        accessibilityLabel={[episode.title, meta, ...marks, reason].filter(Boolean).join(', ')}
        className={cn(
          'min-w-0 flex-1 gap-1 rounded-control',
          Platform.select({ web: `cursor-pointer ${FOCUS_RING_CLASS}` }),
        )}
      >
        <Text variant="title" numberOfLines={2}>
          {episode.title}
        </Text>
        {meta ? (
          <Text variant="caption" numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
        {marks.length > 0 || episode.removed ? (
          <View className="flex-row flex-wrap gap-1.5">
            {marks.map((m) => (
              <Badge key={m} variant="outline">
                <Text>{m}</Text>
              </Badge>
            ))}
            {episode.removed ? (
              <Badge variant="warning">
                <Text>{t('podcasts.show.removed')}</Text>
              </Badge>
            ) : null}
          </View>
        ) : null}
        <View className="flex-row items-center gap-2">
          {finished ? (
            <View testID="episode-finished" className="flex-row items-center gap-1">
              <Icon name="circle-check" size={12} color={themed.success} />
              <Text variant="caption">{t('podcasts.episode.finished')}</Text>
            </View>
          ) : (
            <Text
              variant="caption"
              testID="episode-state"
              style={tabularNums}
              className={state.kind === 'failed' ? 'text-destructive' : undefined}
            >
              {stateText(state, t)}
            </Text>
          )}
          {fraction > 0 ? (
            <ProgressBar fraction={fraction} minPercent={3} className="w-16" />
          ) : null}
        </View>
        {reason ? (
          <Text variant="caption" numberOfLines={2} testID="episode-reason">
            {reason}
          </Text>
        ) : null}
      </AnimatedPressable>
      {retryable ? (
        <Button
          variant="outline"
          size="sm"
          icon="rotate"
          title={t('podcasts.episode.tryAgain')}
          accessibilityLabel={t('podcasts.episode.tryAgainLabel', { title: episode.title })}
          onPress={retry}
          testID="episode-retry"
        />
      ) : (
        <Button
          variant="secondary"
          size="sm"
          icon="play"
          title={started ? t('podcasts.episode.resume') : t('podcasts.episode.play')}
          accessibilityLabel={t('podcasts.episode.playLabel', { title: episode.title })}
          disabled={state.kind === 'unavailable'}
          onPress={play}
          testID="episode-play"
        />
      )}
      <BookActionsButton
        connectionId={connectionId}
        libraryId={libraryId}
        book={book}
        progress={progress}
        omit={['play', 'collect', 'series']}
      />
    </View>
  );
}
