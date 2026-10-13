import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { KidsScreen } from '@/components/kids/kids-screen';
import { useKidsActive } from '@/components/kids/use-kids';
import { Screen } from '@/components/ui/screen';
import { Spinner } from '@/components/ui/spinner';
import { usePageTitle } from '@/lib/use-page-title';

/**
 * Kids mode (Phase 8): the whole app for a profile in kids mode, a root route outside the
 * tabs (the gate and `KidsRouteGuard` keep a kids profile here). Thin: no swipe back (iOS
 * would reveal whatever sits under it, which only bounces back), then the screen, only
 * while a kids profile is listening: after kids mode is left the route can stay under the
 * shell until `KidsRouteGuard` takes it off, and it must neither show the grown-up's
 * library as stories nor keep its queries and player running there (a spinner meanwhile,
 * as while the profiles load).
 */
export default function KidsRoute() {
  const { t } = useTranslation();
  const kids = useKidsActive();
  usePageTitle(t('kids.stories.title'));
  return (
    <>
      <Stack.Screen options={{ gestureEnabled: false }} />
      {kids ? (
        <KidsScreen />
      ) : (
        <Screen>
          <Spinner center />
        </Screen>
      )}
    </>
  );
}
