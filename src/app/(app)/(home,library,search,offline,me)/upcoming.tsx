import { useTranslation } from 'react-i18next';

import { TabPageScroll } from '@/components/shell/tab-page-scroll';
import { UpcomingContent } from '@/components/upcoming/upcoming-screen';
import { usePageTitle } from '@/lib/use-page-title';

// /upcoming (upcomingHref, Track U2): the listener's upcoming releases on every server, a
// page of the array group pushed on the current tab (Home's Coming up in your series > See
// all), so back returns there; a cold link opens it in Home. The You hub also has it as its
// Upcoming section while a server offers it.
export default function UpcomingScreen() {
  const { t } = useTranslation();
  usePageTitle(t('upcoming.title'));
  return (
    <TabPageScroll testID="upcoming-scroll" contentContainerClassName="gap-6">
      <UpcomingContent />
    </TabPageScroll>
  );
}
