import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { sectionParam } from '@/components/settings/settings-model';
import { SettingsContent } from '@/components/settings/settings-content';
import { usePageTitle } from '@/lib/use-page-title';

// /settings[?section=preferences|accounts|<pane>] (settingsHref): every app setting. A page
// of the array group, so the top bar's gear pushes it on the current tab and back returns
// there; a cold link opens it in Home. The phone reaches the same content in the You hub.
export default function SettingsScreen() {
  const { t } = useTranslation();
  const { section } = useLocalSearchParams<{ section?: string }>();
  usePageTitle(t('settings.title'));
  return (
    <SettingsContent
      section={section}
      onSectionChange={(pane) => router.setParams({ section: sectionParam(pane) })}
    />
  );
}
