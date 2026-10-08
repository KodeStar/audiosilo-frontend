import { router, useNavigation } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { useScopedCid } from '@/api/provider';
import { accountParentKey, routeUnderAccount } from '@/components/account/account-model';
import { AccountSection } from '@/components/account/account-section';
import { ContentScope } from '@/components/layout/content-scope';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { BreadCrumbs, type Crumb } from '@/components/ui/breadcrumbs';
import { useSession } from '@/stores/session';

/**
 * Per-connection account screen (`/account?connection=<cid>`), reached from Settings'
 * servers list (the Settings page, or the phone You hub's Settings section) and the
 * profile menu. The body is `AccountSection`, which the phone You hub's Account segment
 * renders too; this route adds the scroll and a breadcrumb back to the page it was
 * opened from (`accountParentKey`: Settings, a hub section, else a plain Back).
 *
 * The `?connection=` scope comes from this route's OWN local param (reliable on a cold
 * deep link; `ContentScope` redirects home for a server that isn't signed in), read via
 * `useScopedCid()`, so the body is a child of `<ContentScope>`. Without the param the
 * section shows the default server with a server switcher.
 */
export default function AccountScreen() {
  return (
    <ContentScope>
      <AccountContent />
    </ContentScope>
  );
}

function AccountContent() {
  const { t } = useTranslation();
  const cid = useScopedCid();
  const name = useSession((s) => s.connections.find((c) => c.id === cid)?.name);
  const paddingBottom = useMiniPlayerInset();
  const navigation = useNavigation();
  // Read once: the page is on top of its stack when it mounts.
  const [parentKey] = useState(() =>
    accountParentKey(routeUnderAccount(navigation.getState()?.routes ?? [])),
  );

  const crumbs: Crumb[] = [
    { label: t(parentKey), onPress: () => router.back() },
    { label: name ?? t('settings.account.label'), active: true },
  ];

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-6 p-4 lg:px-8"
      contentContainerStyle={{ paddingBottom }}
      keyboardShouldPersistTaps="handled"
    >
      <View className="w-full max-w-[880px] self-center">
        <BreadCrumbs crumbs={crumbs} />
      </View>
      <AccountSection connectionId={cid || undefined} />
    </ScrollView>
  );
}
