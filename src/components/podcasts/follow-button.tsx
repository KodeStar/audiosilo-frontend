import type { ParseKeys } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiErrorKind } from '@/api/client';
import { CapabilityError, useCapability, useFollowPodcast, useUnfollowPodcast } from '@/api/hooks';
import type { PodcastShow } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { isKidAccount } from '@/lib/account';
import { useSession } from '@/stores/session';

/** A refused follow or unfollow, in the listener's words (never the server's English). */
function followErrorKey(e: unknown): ParseKeys {
  switch (apiErrorKind(e)) {
    case 'module_off':
      return 'podcasts.follow.errorModuleOff';
    case 'kid_account':
      return 'podcasts.follow.errorKid';
    case 'demo_account':
      return 'podcasts.follow.errorDemo';
    case 'show_not_found':
      return 'podcasts.follow.errorGone';
    default:
      return 'podcasts.follow.errorFailed';
  }
}

/**
 * Follow or unfollow a show (Bridge Phase 2d-1, the Podcasts module's write). A button
 * only while the server can follow (`podcasts`: the module on and its Bridge online) for
 * a listener who may (not a kid's account, not the demo); otherwise a followed show
 * shows a quiet "Following" badge and any other nothing (decision 6.3). Unfollowing a
 * private feed asks first: following it again needs its address. `onGone` runs when the
 * show is no longer there (the list is read again) or a private one was unfollowed.
 */
export function FollowButton({
  connectionId,
  show,
  onGone,
}: {
  connectionId: string;
  show: PodcastShow;
  onGone?: () => void;
}) {
  const { t } = useTranslation();
  const can = useCapability('podcasts', connectionId) === true;
  const user = useSession((s) => s.connections.find((c) => c.id === connectionId)?.user);
  const follow = useFollowPodcast(connectionId);
  const unfollow = useUnfollowPodcast(connectionId);
  const [confirming, setConfirming] = useState(false);
  const busy = follow.isPending || unfollow.isPending;

  if (!can || isKidAccount(user) || user?.is_demo) {
    return show.following ? (
      <Badge variant="secondary" testID="podcast-following-badge">
        <Text>{t('podcasts.follow.following')}</Text>
      </Badge>
    ) : null;
  }

  const target = { libraryId: show.library_id, path: show.path };
  const failed = (e: unknown) => {
    if (e instanceof CapabilityError) return;
    toast({ title: t(followErrorKey(e)) });
    if (apiErrorKind(e) === 'show_not_found') onGone?.();
  };
  const doUnfollow = () =>
    unfollow.mutateAsync(target).then(() => {
      if (show.private) onGone?.();
    }, failed);

  return (
    <>
      {show.following ? (
        <Button
          variant="outline"
          icon="check"
          title={t('podcasts.follow.following')}
          accessibilityLabel={t('podcasts.follow.unfollow')}
          loading={busy}
          onPress={() => (show.private ? setConfirming(true) : void doUnfollow())}
          testID="podcast-unfollow"
        />
      ) : (
        <Button
          icon="plus"
          title={t('podcasts.follow.follow')}
          loading={busy}
          onPress={() => void follow.mutateAsync(target).catch(failed)}
          testID="podcast-follow"
        />
      )}
      <ConfirmDialog
        visible={confirming}
        title={t('podcasts.follow.confirmPrivateTitle')}
        message={t('podcasts.follow.confirmPrivateBody')}
        confirmLabel={t('podcasts.follow.unfollow')}
        destructive
        onConfirm={() => {
          setConfirming(false);
          void doUnfollow();
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
