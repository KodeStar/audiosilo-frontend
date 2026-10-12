import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { YearStoryScreen } from '@/components/you/year/year-story-screen';
import { usePageTitle } from '@/lib/use-page-title';

/**
 * The phone's full-screen Year in listening story, a root modal like the player and the
 * end credits (`?year=YYYY`, `?connection=`, `?card=`; see `yearHref`). Thin: it reads
 * the params and hands off to <YearStoryScreen>.
 */
export default function YearScreen() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ year?: string; connection?: string; card?: string }>();
  usePageTitle(t('you.titles.year'));
  return <YearStoryScreen {...params} />;
}
