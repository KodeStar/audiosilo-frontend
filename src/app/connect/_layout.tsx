import { Stack } from 'expo-router';

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
  // A signed-in user who reaches /connect with no intent to add a server is bounced home
  // by the index route itself (`connect/index.tsx`), from its OWN params. The layout can't
  // decide it: on a link arriving while the app runs, the child's params only reach the
  // layout after the child mounts, so `useGlobalSearchParams` read no `token` on the first
  // render and a pairing link bounced home before it could pair.
  return <Stack screenOptions={{ headerShown: false }} />;
}
