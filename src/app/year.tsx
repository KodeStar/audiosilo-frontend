import { useTranslation } from 'react-i18next';

import { useRouteConnection } from '@/components/layout/content-scope';
import { YearStoryScreen } from '@/components/you/year/year-story-screen';
import { useRouteParams } from '@/lib/route-params';
import { usePageTitle } from '@/lib/use-page-title';

/**
 * The phone's full-screen Year in listening story, a root modal like the player and the
 * end credits (`?year=YYYY`, `?connection=`, `?card=`; see `yearHref`). Thin: it reads
 * the params and hands off to <YearStoryScreen>, unless the route-connection rule shows its
 * gate (`useRouteConnection`: an unknown connection, another person's year).
 */
export default function YearScreen() {
  const { t } = useTranslation();
  const params = useRouteParams<{ year?: string; connection?: string; card?: string }>();
  usePageTitle(t('you.titles.year'));
  const { gate } = useRouteConnection(params.connection);
  return gate ?? <YearStoryScreen {...params} />;
}
