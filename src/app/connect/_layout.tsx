import { Stack } from 'expo-router';
import { useEffect } from 'react';

import { useKidsActive } from '@/components/kids/use-kids';
import {
  endKidsConnect,
  kidsConnectAllowed,
  setConnectForNewProfile,
} from '@/components/profiles/connect-intent';
import { Screen } from '@/components/ui/screen';
import { Spinner } from '@/components/ui/spinner';
import { useSession } from '@/stores/session';

export default function ConnectLayout() {
  const status = useSession((s) => s.status);
  const kids = useKidsActive();
  // "Add someone" holds for the whole flow (`connect/index.tsx` sets it), until the flow
  // is left: the next flow starts as a sign-in of the person listening again. So does a
  // grown-up's pass through kids mode (`kidsConnectAllowed`).
  useEffect(
    () => () => {
      setConnectForNewProfile(false);
      endKidsConnect();
    },
    [],
  );
  // Kids mode never runs the flow (8b-1, D1): not a step of it, so a pairing link's token
  // is never exchanged and no server can be reconnected or forgotten, while the route guard
  // (`KidsRouteGuard`) takes the child back to `/kids`. Only a grown-up's "Add someone" on
  // a device with no grown-up gets through.
  if (status === 'loading' || (kids && !kidsConnectAllowed())) {
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
