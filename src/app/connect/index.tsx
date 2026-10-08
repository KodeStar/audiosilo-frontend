import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { ConnectStart } from '@/components/connect/connect-start';
import { LeaveOnboarding } from '@/components/shell/leave-onboarding';
import { useSession } from '@/stores/session';

/**
 * `/connect`, the first step. An authenticated user can still reach it to ADD another
 * server: the entry point passes ?add=1, a QR/invite carries ?token=, and the sign-in
 * step is mid-flow (pendingServerUrl set). Otherwise they're bounced home. Decided here,
 * from this route's own params (see the note in `_layout.tsx`), and ONCE, when the screen
 * opens: a sign-in finishing on top of it (or the demo, or a link) makes the session
 * authenticated and clears the pending address, and a bounce then would leave
 * onboarding before the flow reaches "Your library is ready.".
 */
export default function ConnectRoute() {
  const status = useSession((s) => s.status);
  const pendingServerUrl = useSession((s) => s.pendingServerUrl);
  const { add, token } = useLocalSearchParams<{ add?: string; token?: string }>();
  const [bounce] = useState(
    () => status === 'authenticated' && !add && !token && !pendingServerUrl,
  );
  if (bounce) return <LeaveOnboarding />;
  return <ConnectStart />;
}
