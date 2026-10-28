import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/ui/empty-state';
import { adminConnection, adminConsoleUrl } from '@/lib/admin-console';
import { openExternalUrl } from '@/lib/support';
import { useSession } from '@/stores/session';

/**
 * The Library with no library to show (the Library tab's and Folders mode's empty state).
 * `offline`: a list still waits for the network, which is not "none shared" (fe#155). A
 * listener is told to ask the server's owner; the owner (signed in as one of
 * `connectionIds`' admin) is the one who adds them, so they get "Add your first library"
 * to the console's setup flow instead (CONNECT-02).
 */
export function NoLibrariesState({
  offline = false,
  connectionIds,
}: {
  offline?: boolean;
  connectionIds?: readonly string[];
}) {
  const { t } = useTranslation();
  const admin = useSession((s) => adminConnection(s.connections, connectionIds));
  if (offline) {
    return (
      <EmptyState
        icon="offline"
        title={t('library.list.offlineTitle')}
        hint={t('library.list.offlineHint')}
      />
    );
  }
  if (admin) {
    return (
      <EmptyState
        icon="library"
        title={t('library.list.noLibrariesAdmin')}
        hint={t('library.list.noLibrariesAdminHint', { name: admin.name })}
        action={{
          label: t('onboarding.ready.addLibrary'),
          icon: 'arrow-up-right',
          onPress: () => void openExternalUrl(adminConsoleUrl(admin.serverUrl, 'setup')),
        }}
      />
    );
  }
  return (
    <EmptyState
      icon="library"
      title={t('library.list.noLibraries')}
      hint={t('library.list.noLibrariesHint')}
    />
  );
}
