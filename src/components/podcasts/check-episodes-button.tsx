import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CapabilityError, qk, useCheckPodcast } from '@/api/hooks';
import type { PodcastShow } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { formatRelative } from '@/lib/format';
import { useMinuteClock } from '@/lib/use-now';

import { checkErrorKey } from './find-shows-model';
import { useAddShowsAccess } from './shows-actions';

/** How often the show is read again while its check runs (its `last_checked` moves when
 * the server's poll job has read the feed). */
export const CHECK_POLL_MS = 3_000;
/** How long the button waits for the check to end before it gives up waiting (a Bridge
 * that went away): the show and its episodes are read once more then. */
export const CHECK_WAIT_MS = 120_000;

/**
 * Check for new episodes (Bridge Phase 2d-2): asks a followed show's feed to be checked
 * now (`POST /podcasts/check`, the module's), and then reads "Asked the server to check"
 * until the check has ended (BRIDGE-15, fe#126). The poll job is not the listener's to
 * read, so its end is seen on the show: the show list is read every `CHECK_POLL_MS`
 * until its `status.last_checked` moves, then the episodes are read again. Waiting stops
 * after `CHECK_WAIT_MS` either way, and with the page. Only for a show the listener
 * follows, on a server that can follow (`podcasts`), not for a kid's account or the demo.
 * Within a minute of the last check the server says so.
 *
 * Beside it, what the check found once it has ended (fe#126): the episodes the show holds
 * now beyond those it held when asked ("2 new episodes", "No new episodes"; a failed
 * check is said by the show page's own line), else when the feed was last checked.
 */
export function CheckEpisodesButton({
  connectionId,
  show,
}: {
  connectionId: string;
  show: PodcastShow;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  // The same rule as adding shows: the module's, not a kid's account or the demo.
  const access = useAddShowsAccess(connectionId);
  const check = useCheckPodcast(connectionId);
  // The show's `last_checked` and episode count when the server took the check; null: no
  // check running.
  const [asked, setAsked] = useState<{ since: string | null; count: number } | null>(null);
  const { library_id: libraryId, path } = show;
  const lastChecked = show.status.last_checked;

  // The check has ended once the show says it was checked since it was asked.
  const ended = asked !== null && !!lastChecked && lastChecked !== asked.since;
  const running = asked !== null && !ended;

  const readEpisodes = useCallback(
    () =>
      void qc.invalidateQueries({
        queryKey: qk.podcastEpisodesOfShow(connectionId, libraryId, path),
      }),
    [qc, connectionId, libraryId, path],
  );
  useEffect(() => {
    if (ended) readEpisodes();
  }, [ended, readEpisodes]);

  useEffect(() => {
    if (!running) return;
    // A slow list read finishes rather than being restarted by the next tick.
    const readShows = () =>
      void qc.invalidateQueries(
        { queryKey: qk.podcastShows(connectionId, libraryId) },
        { cancelRefetch: false },
      );
    const poll = setInterval(readShows, CHECK_POLL_MS);
    const giveUp = setTimeout(() => {
      setAsked(null);
      readShows();
      readEpisodes();
    }, CHECK_WAIT_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(giveUp);
    };
  }, [running, qc, connectionId, libraryId, readEpisodes]);

  const now = useMinuteClock(!!lastChecked);
  if (!show.following || access !== 'allowed') return null;
  const press = () =>
    check.mutateAsync({ libraryId, path }).then(
      () => setAsked({ since: lastChecked, count: show.episode_count }),
      (e: unknown) => {
        if (!(e instanceof CapabilityError)) toast({ title: t(checkErrorKey(e)) });
      },
    );
  const found = ended ? show.episode_count - asked.count : 0;
  // A failed check says nothing here: the show page's own line says it failed.
  const caption = ended
    ? show.status.error
      ? null
      : found > 0
        ? t('podcasts.check.found', { count: found })
        : t('podcasts.check.noNew')
    : !running && lastChecked
      ? t('podcasts.check.lastChecked', {
          when: formatRelative(lastChecked, i18n.language || 'en', now),
        })
      : null;
  return (
    <>
      <Button
        variant="outline"
        icon="rotate"
        title={running ? t('podcasts.check.asked') : t('podcasts.check.action')}
        loading={check.isPending || running}
        onPress={() => void press()}
        testID="podcast-check"
      />
      {caption ? (
        <Text variant="caption" className="self-center" testID="podcast-check-result">
          {caption}
        </Text>
      ) : null}
    </>
  );
}
