import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BookCover } from '@/components/library/book-cover';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  cancelEpisodeFetch,
  type PendingEpisodeFetch,
  retryEpisodeFetch,
  useEpisodeFetch,
} from '@/playback/episode-fetch';
import { useThemeColors } from '@/theme/use-theme-colors';

import { fetchProgress, fetchReasonKey } from './podcast-model';

/** Whether the fetch stopped and only Try again moves it on. */
function stopped(p: PendingEpisodeFetch): boolean {
  return p.phase === 'failed' || p.phase === 'unavailable' || p.phase === 'refused';
}

/** The fetch's lines, shared by the panel and the strip: a heading, then what it is doing
 * (how far, waiting its turn) or why it stopped, and the bar's share when known. */
function useFetchCopy(p: PendingEpisodeFetch) {
  const { t } = useTranslation();
  const { received, total, percent } = fetchProgress(p.status);
  if (stopped(p)) {
    return {
      heading: t(
        p.phase === 'failed' ? 'podcasts.fetch.failedTitle' : 'podcasts.fetch.unavailableTitle',
      ),
      line: t(fetchReasonKey(p.code)),
      fraction: null,
    };
  }
  const line =
    p.phase === 'waiting' && p.status?.state === 'fetching'
      ? total !== null
        ? t('podcasts.fetch.progress', {
            received: formatBytes(received),
            total: formatBytes(total),
          })
        : t('podcasts.fetch.progressUnknown', { received: formatBytes(received) })
      : p.phase === 'waiting'
        ? t('podcasts.fetch.queued')
        : t('podcasts.fetch.body');
  return {
    heading: t('podcasts.fetch.title'),
    line,
    fraction: percent === null ? null : percent / 100,
  };
}

/**
 * The full player's place while an episode is fetched (Bridge Phase 2d-1): its cover,
 * title and show, how far the fetch is, Cancel, and Try again once it stopped. The player
 * route shows it while the fetch is for its episode; once the episode starts, the player
 * takes over.
 */
export function EpisodeFetchPanel({ onClose }: { onClose: () => void }) {
  const pending = useEpisodeFetch((s) => s.pending);
  if (!pending) return <Spinner center />;
  return <Panel pending={pending} onClose={onClose} />;
}

function Panel({ pending, onClose }: { pending: PendingEpisodeFetch; onClose: () => void }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const themed = useThemeColors();
  const copy = useFetchCopy(pending);
  const { connectionId, libraryId, path } = pending.target;
  const onCancel = () => {
    cancelEpisodeFetch();
    onClose();
  };
  return (
    <View
      testID="episode-fetch-panel"
      className="flex-1"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <View className="h-14 flex-row items-center px-3">
        <Button
          variant="ghost"
          size="icon"
          onPress={onClose}
          accessibilityLabel={t('player.full.minimise')}
        >
          <Icon name="chevron-down" size={22} color={themed.foreground} />
        </Button>
      </View>
      <View className="flex-1 items-center justify-center gap-5 px-8">
        <BookCover
          connectionId={connectionId}
          libraryId={libraryId}
          path={path}
          title={pending.title}
          author={pending.show}
          width={200}
          shadow="lg"
        />
        <View className="items-center gap-1">
          <Text variant="heading" className="text-center" numberOfLines={2}>
            {pending.title}
          </Text>
          <Text variant="muted" className="text-center" numberOfLines={1}>
            {pending.show}
          </Text>
        </View>
        <View className="w-full max-w-sm items-center gap-2" aria-live="polite">
          <Text variant="label" className="text-center">
            {copy.heading}
          </Text>
          <Text variant="muted" className="text-center" testID="episode-fetch-line">
            {copy.line}
          </Text>
          {copy.fraction !== null ? (
            <ProgressBar fraction={copy.fraction} minPercent={2} className="mt-1 w-full" />
          ) : !stopped(pending) ? (
            <Spinner />
          ) : null}
        </View>
        <View className="flex-row gap-3">
          {stopped(pending) ? (
            <Button
              icon="rotate"
              title={t('podcasts.fetch.tryAgain')}
              onPress={retryEpisodeFetch}
              testID="episode-fetch-retry"
            />
          ) : null}
          <Button
            variant="outline"
            title={t('podcasts.fetch.cancel')}
            accessibilityLabel={t('podcasts.fetch.cancelLabel', { title: pending.title })}
            onPress={onCancel}
            testID="episode-fetch-cancel"
          />
        </View>
      </View>
    </View>
  );
}

/**
 * The fetch in a compact row (Bridge Phase 2d-1), for the docked bar (wide) and the mini
 * player (phone, the full player closed): above the book that plays on meanwhile, or alone
 * when nothing does. Nothing while no fetch is on its way.
 */
export function EpisodeFetchStrip({ className }: { className?: string }) {
  const pending = useEpisodeFetch((s) => s.pending);
  if (!pending) return null;
  return <Strip pending={pending} className={className} />;
}

function Strip({ pending, className }: { pending: PendingEpisodeFetch; className?: string }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const copy = useFetchCopy(pending);
  const { connectionId, libraryId, path } = pending.target;
  return (
    <View
      testID="episode-fetch-strip"
      accessibilityLabel={t('podcasts.fetch.stripLabel', { title: pending.title })}
      className={cn('flex-row items-center gap-3 px-3 py-2', className)}
    >
      <BookCover
        connectionId={connectionId}
        libraryId={libraryId}
        path={path}
        title={pending.title}
        author={pending.show}
        width={36}
        thumbnail={160}
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="label" numberOfLines={1}>
          {pending.title}
        </Text>
        <Text variant="caption" numberOfLines={1} aria-live="polite">
          {stopped(pending) ? copy.heading : copy.line}
        </Text>
        {copy.fraction !== null ? (
          <ProgressBar fraction={copy.fraction} minPercent={2} className="mt-0.5" />
        ) : null}
      </View>
      {stopped(pending) ? (
        <Button
          variant="ghost"
          size="sm"
          title={t('podcasts.fetch.tryAgain')}
          onPress={retryEpisodeFetch}
          testID="episode-fetch-strip-retry"
        />
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        onPress={cancelEpisodeFetch}
        accessibilityLabel={t('podcasts.fetch.cancelLabel', { title: pending.title })}
        testID="episode-fetch-strip-cancel"
      >
        <Icon name="close" size={16} color={themed.mutedForeground} />
      </Button>
    </View>
  );
}
