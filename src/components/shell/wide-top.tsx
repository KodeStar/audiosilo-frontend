import { OfflineBanner } from '@/components/layout/offline-banner';
import { ReconnectBanner } from '@/components/layout/reconnect-banner';

import { SubNav } from './sub-nav';
import { TopBar } from './top-bar';

/** The tablet/desktop chrome above the page: the top bar, the sub-nav row, then the
 * app-wide banners (STYLEGUIDE section 8: banners sit under the top bar). */
export function WideTop() {
  return (
    <>
      <TopBar />
      <SubNav />
      <ReconnectBanner />
      <OfflineBanner />
    </>
  );
}
