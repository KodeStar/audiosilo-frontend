import { useTranslation } from 'react-i18next';

import { ProfilesScreen } from '@/components/profiles/profiles-screen';
import { usePageTitle } from '@/lib/use-page-title';

/**
 * "Who's listening?" (Phase 8), a full-screen root route like the player and the credits.
 * Thin: see <ProfilesScreen>.
 */
export default function ProfilesRoute() {
  const { t } = useTranslation();
  usePageTitle(t('profiles.picker.title'));
  return <ProfilesScreen />;
}
