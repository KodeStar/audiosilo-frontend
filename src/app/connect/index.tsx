import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import { ConnectStart } from '@/components/connect/connect-start';
import { LeaveOnboarding, leaveOnboarding } from '@/components/shell/leave-onboarding';
import { useSession } from '@/stores/session';

/**
 * `/connect`, the first step. An authenticated user can still reach it to ADD another
 * server: the entry point passes ?add=1, a QR/invite carries ?token=, and the sign-in
 * step is mid-flow (pendingServerUrl set). Otherwise they're bounced home. Decided here,
 * from this route's own params (see the note in `_layout.tsx`):
 *
 * - when the screen opens, and
 * - when it is back on top (back from "Your library is ready.", or from a sign-in that
 *   finished), never while another screen of the flow is over it: a sign-in finishing
 *   on top makes the session authenticated and clears the pending address, and a bounce
 *   then would leave onboarding before the flow reaches "Your library is ready.".
 */
export default function ConnectRoute() {
  const status = useSession((s) => s.status);
  const pendingServerUrl = useSession((s) => s.pendingServerUrl);
  const { add, token } = useLocalSearchParams<{ add?: string; token?: string }>();
  const [bounce] = useState(
    () => status === 'authenticated' && !add && !token && !pendingServerUrl,
  );
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      const s = useSession.getState();
      if (shown.current && s.status === 'authenticated' && !add && !token && !s.pendingServerUrl) {
        leaveOnboarding();
      }
      shown.current = true;
    }, [add, token]),
  );
  if (bounce) return <LeaveOnboarding />;
  return <ConnectStart />;
}
