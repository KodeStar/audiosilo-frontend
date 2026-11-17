import { Stack, useRootNavigationState, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { dropConnectHandoffs } from '@/components/connect/invite-handoff';
import { dropOidcIntent, resumeOidcIntent, takeOidcIntent } from '@/components/connect/oidc-intent';
import { oidcReturnOnLoad } from '@/components/connect/oidc-sign-in';
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
 * through (`kidsConnectAllowed`), and across a single sign-on's trip to the provider only
 * once the returned sign-in has finished (`oidc-intent.ts`).
 *
 * A flow opened while kids mode was already on is a link (`audiosilo://connect?token=`, a
 * QR scanned elsewhere, `/web/connect`, an old sign-in step from the web history): a toast
 * asks a grown-up to open it (the grown-up holds Grown-ups, chooses themselves with their PIN,
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
  // The hook, not the module-level `router`: that throws until the router's first commit
  // has bound it (expo-router 58), and a cold kids-mode link can run this effect first.
  const router = useRouter();
  // Whether kids mode is on can only be told once both are read.
  const known = status !== 'loading' && profilesRead;
  // A single sign-on's return is a page load: what the flow was for before the trip comes
  // back from this tab's storage (`takeOidcIntent`, fe#310), put back once the profiles are
  // read. A grown-up's pass through kids mode is not: it waits on the sign-in's finish
  // (`passWaits`, until `settleOidcPass`), and meanwhile kids mode lets only the return's own
  // screen run, which finishes the sign-in and shows nothing else. No session, no pass: the
  // address typed after a trip abandoned at the provider opens nothing for a child.
  const [held, setHeld] = useState(() => takeOidcIntent(oidcReturnOnLoad()));
  const [passWaiting, setPassWaiting] = useState(false);
  // This render's own answer: the state it sets only shows in the next one.
  let passWaits = passWaiting;
  if (known && held) {
    passWaits = resumeOidcIntent(held, () => setPassWaiting(false));
    setPassWaiting(passWaits);
    setHeld(null);
  }
  const refused = known && kids && !kidsConnectAllowed() && !passWaits;
  // Kids mode was on as the flow opened (the first render that can tell): a link, not a
  // sign-in that turned it on. Follows the render (React's way to keep state in step).
  const [openedInKids, setOpenedInKids] = useState<boolean | null>(null);
  if (known && openedInKids === null) setOpenedInKids(refused);
  // Leaving the flow also drops the proxy headers held for it (fe#167): in memory only, and
  // only until a sign-in keeps them with its connection. And a reconnect the scanner or the
  // sign-in step was handed that nothing took (`dropConnectHandoffs`), and a single sign-on's
  // intent still in the tab (`dropOidcIntent`: a trip abandoned at the provider).
  useEffect(
    () => () => {
      endConnectFlow();
      dropConnectHandoffs();
      dropOidcIntent();
      useSession.getState().setPendingProxyHeaders(null);
    },
    [],
  );
  useEffect(() => {
    if (!refused || !ready) return;
    if (openedInKids) toast({ title: t('kids.link.title'), description: t('kids.link.body') });
    router.dismissTo(KIDS_PATH);
  }, [refused, ready, openedInKids, t, router]);
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
