import { useGlobalSearchParams } from 'expo-router';

import { OfflineBanner } from '@/components/layout/offline-banner';
import { ReconnectBanner } from '@/components/layout/reconnect-banner';
import { connectionParam } from '@/lib/paths';

import { SubNav } from './sub-nav';
import { TopBar } from './top-bar';

/** The tablet/desktop chrome above the page: the top bar, the sub-nav row, then the
 * app-wide banners (STYLEGUIDE section 8: banners sit under the top bar). */
export function WideTop() {
  // The focused page's connection (one subscription, for the one wide banner row).
  const { connection } = useGlobalSearchParams<{ connection?: string | string[] }>();
  return (
    <>
      <TopBar />
      <SubNav />
      <ReconnectBanner />
      <OfflineBanner connectionId={connectionParam(connection)} />
    </>
  );
}
