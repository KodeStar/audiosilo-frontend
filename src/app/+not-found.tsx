import { router } from 'expo-router';
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/ui/empty-state';
import { Screen } from '@/components/ui/screen';
import { usePageTitle } from '@/lib/use-page-title';

/**
 * Any address the app has no page for (a mistyped or old `/web/...` link): the app's own
 * "Page not found", in its theme, with a way Home, in place of Expo Router's unbranded
 * "Unmatched Route" page and its Sitemap (turned off in `app.json`).
 *
 * Web: the server answers an unknown path with the player's `index.html` (the static
 * render of Home, which is empty until the stores load), so while the page hydrates it
 * renders the same empty view, and shows right after (`useHydrated`). Rendering it at
 * once would not match the HTML the browser hydrates (React's error #418). A render that
 * hydrates nothing (native, a client-side navigation) shows it at once.
 */
export default function NotFoundScreen() {
  const { t } = useTranslation();
  const hydrated = useHydrated();
  usePageTitle(t('common.notFound.title'));
  if (!hydrated) return <View style={{ flex: 1 }} />;
  return (
    <Screen testID="not-found">
      <EmptyState
        className="flex-1"
        icon="link"
        title={t('common.notFound.title')}
        hint={t('common.notFound.body')}
        // `dismissTo`, never `replace`: `(app)` is the root stack's anchor and already sits
        // under this page, so a replace would stack a second `(app)` (`leaveOnboarding`).
        action={{ label: t('common.notFound.home'), onPress: () => router.dismissTo('/') }}
      />
    </Screen>
  );
}

const noSubscribe = () => () => {};

/** False only while React hydrates server-rendered HTML (its server snapshot), then true. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}
