import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { CapabilityError, qk, useCapability, useCheckPodcast } from '@/api/hooks';
import type { PodcastShow } from '@/api/types';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { isKidAccount } from '@/lib/account';
import { useSession } from '@/stores/session';

import { checkErrorKey } from './find-shows-model';

/** How long after a check the show and its episodes are read again (a check is not a
 * follow request, so nothing follows it: one look, a while later). */
export const CHECK_REFRESH_MS = 15_000;

/**
 * Check for new episodes (Bridge Phase 2d-2): asks a followed show's feed to be checked
 * now (`POST /podcasts/check`, the module's), toasts that it started, and reads the show
 * and its episodes again once, 15 s later (the timer ends with the page). Only for a show
 * the listener follows, on a server that can follow (`podcasts`), not for a kid's account
 * or the demo. Within a minute of the last check the server says so.
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
  const can = useCapability('podcasts', connectionId) === true;
  const user = useSession((s) => s.connections.find((c) => c.id === connectionId)?.user);
  const check = useCheckPodcast(connectionId);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  if (!show.following || !can || isKidAccount(user) || user?.is_demo) return null;
  const press = () =>
    check.mutateAsync({ libraryId: show.library_id, path: show.path }).then(
      () => {
        toast({ title: t('podcasts.check.started') });
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          void qc.invalidateQueries({ queryKey: qk.podcastShows(connectionId, show.library_id) });
          void qc.invalidateQueries({
            queryKey: qk.podcastEpisodesOfShow(connectionId, show.library_id, show.path),
          });
        }, CHECK_REFRESH_MS);
      },
      (e: unknown) => {
        if (!(e instanceof CapabilityError)) toast({ title: t(checkErrorKey(e)) });
      },
    );
  return (
    <Button
      variant="outline"
      icon="rotate"
      title={t('podcasts.check.action')}
      loading={check.isPending}
      onPress={() => void press()}
      testID="podcast-check"
    />
  );
}
