import { Redirect } from 'expo-router';
import { useState } from 'react';

import { takeInviteCode } from '@/components/connect/invite-handoff';
import { SignInStep } from '@/components/connect/sign-in-step';
import { useRouteParams } from '@/lib/route-params';
import { useSession } from '@/stores/session';

/**
 * `/connect/sign-in`, reached mid-connect with the server being connected to in
 * `pendingServerUrl` (the first step, or the reconnect banner, which passes `reconnect`:
 * the connection it re-pairs). The address is read once, when the screen opens: signing
 * in clears it, and the screen must not bounce back to the first step while the flow
 * moves on to "Your library is ready.". A scanned or pasted invite link hands its code
 * along (`holdInvite`), and the step signs in with it at once.
 */
export default function SignInRoute() {
  const { serverName, reconnect } = useRouteParams<{
    serverName?: string;
    reconnect?: string;
  }>();
  const [{ server, code }] = useState(() => {
    const pending = useSession.getState().pendingServerUrl;
    return { server: pending, code: pending ? takeInviteCode(pending) : undefined };
  });
  if (!server) return <Redirect href="/connect" />;
  return (
    <SignInStep
      server={server}
      serverName={serverName}
      reconnectId={reconnect}
      initialCode={code}
    />
  );
}
