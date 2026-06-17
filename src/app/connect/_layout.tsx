import { Redirect, Stack } from 'expo-router';

import { Screen } from '@/components/ui/screen';
import { Spinner } from '@/components/ui/spinner';
import { useSession } from '@/stores/session';

export default function ConnectLayout() {
  const status = useSession((s) => s.status);

  if (status === 'loading') {
    return (
      <Screen>
        <Spinner center />
      </Screen>
    );
  }
  if (status === 'authenticated') {
    return <Redirect href="/" />;
  }
  return <Stack screenOptions={{ headerShown: false }} />;
}
