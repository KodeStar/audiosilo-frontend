import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { isHouseholdSection, sectionParam } from '@/components/settings/settings-model';
import { SettingsContent } from '@/components/settings/settings-content';
import { householdHref } from '@/lib/paths';
import { usePageTitle } from '@/lib/use-page-title';

// /settings[?section=preferences|accounts|<pane>] (settingsHref): every app setting. A page
// of the array group, so the top bar's gear pushes it on the current tab and back returns
// there; a cold link opens it in Home. The phone reaches the same content in the You hub.
// `?section=household` (the pane before Phase 8b-1) is the Household page now: the route
// REPLACES itself with it, so back doesn't bounce into this redirect again.
export default function SettingsScreen() {
  const { t } = useTranslation();
  const { section } = useLocalSearchParams<{ section?: string }>();
  usePageTitle(t('settings.title'));
  if (isHouseholdSection(section)) return <Redirect href={householdHref()} />;
  return (
    <SettingsContent
      section={section}
      onSectionChange={(pane) => router.setParams({ section: sectionParam(pane) })}
    />
  );
}
