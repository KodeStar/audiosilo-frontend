import { useLocalSearchParams } from 'expo-router';

import { useRouteConnection } from '@/components/layout/content-scope';
import { YearStoryScreen } from '@/components/you/year/year-story-screen';

/**
 * The phone's full-screen Year in listening story, a root modal like the player and the
 * end credits (`?year=YYYY`, `?connection=`, `?card=`; see `yearHref`). Thin: it reads
 * the params and hands off to <YearStoryScreen>, unless the route-connection rule shows its
 * gate (`useRouteConnection`: an unknown connection, another person's year).
 */
export default function YearScreen() {
  const params = useLocalSearchParams<{ year?: string; connection?: string; card?: string }>();
  const { gate } = useRouteConnection(params.connection);
  return gate ?? <YearStoryScreen {...params} />;
}
