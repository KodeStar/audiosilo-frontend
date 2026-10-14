import { router, Stack, useRootNavigationState } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { KIDS_PATH } from '@/components/kids/kids-model';
import { useKidsActive } from '@/components/kids/use-kids';
import { endConnectFlow, kidsConnectAllowed } from '@/components/profiles/connect-intent';
import { Screen } from '@/components/ui/screen';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';

/**
 * The connect flow's layout, and the one gate between it and kids mode (8b-1, D1): while a
 * kids profile listens it runs none of the flow (not a step of it, so a pairing link's
 * token is never exchanged and no server can be reconnected or forgotten) and takes the
 * child back to `/kids`. Only a grown-up's "Add someone" on a device with no grown-up gets
 * through (`kidsConnectAllowed`).
 *
 * A flow opened while kids mode was already on is a link (`audiosilo://connect?token=`, a
 * QR scanned elsewhere, `/web/connect`, the old reconnect banner's sign-in): a toast asks a
 * grown-up to open it (the grown-up holds Grown-ups, chooses themselves with their PIN,
 * then opens the link again). Kids mode turning on while the flow is up is a kid's first
 * sign-in (`finishConnect` takes them to `/kids` itself): no toast, no "Your library is
 * ready." for a kid's account.
 *
 * Nothing of the flow runs until both the session and the profiles are read (a cold start
 * through a link reaches this layout before either): before the profiles, kids mode can't
 * be told, and a link's token would be spent on a kids device. A read of the profiles that
 * fails keeps the flow waiting, as the app's own gate does (`AuthGate`).
 *
 * `dismissTo`, as the route guard (`KidsRouteGuard`) does, once the root navigator is ready
 * (a navigation before it mounts throws). Leaving the flow ends what it was for
 * (`endConnectFlow`: "Add someone", the grown-up's pass through kids mode).
 */
export default function ConnectLayout() {
  const { t } = useTranslation();
  const status = useSession((s) => s.status);
  const profilesRead = useProfiles((s) => s.hydrated);
  const kids = useKidsActive();
  const ready = !!useRootNavigationState()?.key;
  // Whether kids mode is on can only be told once both are read.
  const known = status !== 'loading' && profilesRead;
  const refused = known && kids && !kidsConnectAllowed();
  // Kids mode was on as the flow opened (the first render that can tell): a link, not a
  // sign-in that turned it on. Follows the render (React's way to keep state in step).
  const [openedInKids, setOpenedInKids] = useState<boolean | null>(null);
  if (known && openedInKids === null) setOpenedInKids(refused);
  useEffect(() => () => endConnectFlow(), []);
  useEffect(() => {
    if (!refused || !ready) return;
    if (openedInKids) toast({ title: t('kids.link.title'), description: t('kids.link.body') });
    router.dismissTo(KIDS_PATH);
  }, [refused, ready, openedInKids, t]);
  if (!known || refused) {
    return (
      <Screen>
        <Spinner center />
      </Screen>
    );
  }
  // A signed-in user who reaches /connect with no intent to add a server is bounced home
  // by the index route itself (`connect/index.tsx`), from its OWN params. The layout can't
  // decide it: on a link arriving while the app runs, the child's params only reach the
  // layout after the child mounts, so `useGlobalSearchParams` read no `token` on the first
  // render and a pairing link bounced home before it could pair.
  return (
    <Stack screenOptions={{ headerShown: false }}>
      {/* The first run's end: the sign-in it replaced is spent, so no swipe back to it. */}
      <Stack.Screen name="ready" options={{ gestureEnabled: false }} />
    </Stack>
  );
}
