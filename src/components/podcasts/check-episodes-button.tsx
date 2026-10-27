import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CapabilityError, qk, useCheckPodcast } from '@/api/hooks';
import type { PodcastShow } from '@/api/types';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';

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
 */
export function CheckEpisodesButton({
  connectionId,
  show,
}: {
  connectionId: string;
  show: PodcastShow;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  // The same rule as adding shows: the module's, not a kid's account or the demo.
  const access = useAddShowsAccess(connectionId);
  const check = useCheckPodcast(connectionId);
  // The show's `last_checked` when the server took the check; null: no check running.
  const [asked, setAsked] = useState<{ since: string | null } | null>(null);
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
    const readShows = () =>
      void qc.invalidateQueries({ queryKey: qk.podcastShows(connectionId, libraryId) });
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

  if (!show.following || access !== 'allowed') return null;
  const press = () =>
    check.mutateAsync({ libraryId, path }).then(
      () => setAsked({ since: lastChecked }),
      (e: unknown) => {
        if (!(e instanceof CapabilityError)) toast({ title: t(checkErrorKey(e)) });
      },
    );
  return (
    <Button
      variant="outline"
      icon="rotate"
      title={running ? t('podcasts.check.asked') : t('podcasts.check.action')}
      loading={check.isPending || running}
      onPress={() => void press()}
      testID="podcast-check"
    />
  );
}
