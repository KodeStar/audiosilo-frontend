import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ConnectStart } from '@/components/connect/connect-start';
import { setConnectForNewProfile } from '@/components/profiles/connect-intent';
import { LeaveOnboarding, leaveOnboarding } from '@/components/shell/leave-onboarding';
import { useRouteParams } from '@/lib/route-params';
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
  const { add, token, profile } = useRouteParams<{
    add?: string;
    token?: string;
    profile?: string;
  }>();
  // "Add someone" (`profile=new`): the connection this flow makes is a new person's. The
  // intent is the whole flow's, not this screen's params: the QR scan replaces its own
  // screen with another /connect that carries only the link, and "Use another server"
  // comes back here with no params, so neither may clear it. An explicit "Add a server"
  // (`add=1` without it) does, and so does leaving the flow (`connect/_layout.tsx`).
  useEffect(() => {
    if (profile === 'new') setConnectForNewProfile(true);
    else if (add === '1') setConnectForNewProfile(false);
  }, [add, profile]);
  const [bounce] = useState(
    () => status === 'authenticated' && !add && !token && !pendingServerUrl,
  );
  // A pairing link's flow stays one after its dead token leaves the address (CONNECT-14):
  // the screen must not bounce home while it says why the link failed.
  const [linked, setLinked] = useState(!!token);
  if (token && !linked) setLinked(true);
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      const s = useSession.getState();
      if (
        shown.current &&
        s.status === 'authenticated' &&
        !add &&
        !token &&
        !linked &&
        !s.pendingServerUrl
      ) {
        leaveOnboarding();
      }
      shown.current = true;
    }, [add, token, linked]),
  );
  if (bounce) return <LeaveOnboarding />;
  return <ConnectStart />;
}
