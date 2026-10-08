import { useLocalSearchParams } from 'expo-router';

import { YearStoryScreen } from '@/components/you/year/year-story-screen';

/**
 * The phone's full-screen Year in listening story, a root modal like the player and the
 * end credits (`?year=YYYY`, `?connection=`, `?card=`; see `yearHref`). Thin: it reads
 * the params and hands off to <YearStoryScreen>.
 */
export default function YearScreen() {
  const params = useLocalSearchParams<{ year?: string; connection?: string; card?: string }>();
  return <YearStoryScreen {...params} />;
}
