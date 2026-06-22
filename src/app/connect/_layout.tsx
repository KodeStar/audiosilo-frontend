import { Redirect, Stack, useGlobalSearchParams } from 'expo-router';

import { Screen } from '@/components/ui/screen';
import { Spinner } from '@/components/ui/spinner';
import { useSession } from '@/stores/session';

export default function ConnectLayout() {
  const status = useSession((s) => s.status);
  const pendingServerUrl = useSession((s) => s.pendingServerUrl);
  // An authenticated user can still reach /connect to ADD another server: the
  // entry point passes ?add=1, a QR/invite carries ?token=, and the sign-in step
  // is mid-flow (pendingServerUrl set). Otherwise they're bounced home.
  const { add, token } = useGlobalSearchParams<{ add?: string; token?: string }>();
  const adding = !!add || !!token || !!pendingServerUrl;

  if (status === 'loading') {
    return (
      <Screen>
        <Spinner center />
      </Screen>
    );
  }
  if (status === 'authenticated' && !adding) {
    return <Redirect href="/" />;
  }
  return <Stack screenOptions={{ headerShown: false }} />;
}
