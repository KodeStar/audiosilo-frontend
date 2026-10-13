import { useTranslation } from 'react-i18next';

import { HouseholdPage } from '@/components/household/household-page';
import { TabPageScroll } from '@/components/shell/tab-page-scroll';
import { usePageTitle } from '@/lib/use-page-title';

// /household (householdHref, Phase 8b-1): the people on this device, the household
// members the person listening manages and house sharing. A page of the array group like
// Settings, pushed on the current tab (`openHousehold`: the profile menu, "Who's
// listening?", Settings, Home's house row), so back returns there; a cold link opens it in
// Home. The phone's You hub also has it as its Household segment.
export default function HouseholdScreen() {
  const { t } = useTranslation();
  usePageTitle(t('household.title'));
  return (
    <TabPageScroll testID="household-scroll" contentContainerClassName="gap-6">
      <HouseholdPage />
    </TabPageScroll>
  );
}
