import { Stack } from 'expo-router';

import { KidsScreen } from '@/components/kids/kids-screen';

/**
 * Kids mode (Phase 8): the whole app for a profile in kids mode, a root route outside the
 * tabs (the gate and `KidsRouteGuard` keep a kids profile here). Thin: no swipe back (iOS
 * would reveal whatever sits under it, which only bounces back), then the screen.
 */
export default function KidsRoute() {
  return (
    <>
      <Stack.Screen options={{ gestureEnabled: false }} />
      <KidsScreen />
    </>
  );
}
