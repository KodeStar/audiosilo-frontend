import { Redirect, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { SignInStep } from '@/components/connect/sign-in-step';
import { useSession } from '@/stores/session';

/**
 * `/connect/sign-in`, reached mid-connect with the server being connected to in
 * `pendingServerUrl` (the first step, or the reconnect banner, which passes `reconnect`:
 * the connection it re-pairs). The address is read once, when the screen opens: signing
 * in clears it, and the screen must not bounce back to the first step while the flow
 * moves on to "Your library is ready.".
 */
export default function SignInRoute() {
  const { serverName, reconnect } = useLocalSearchParams<{
    serverName?: string;
    reconnect?: string;
  }>();
  const [server] = useState(() => useSession.getState().pendingServerUrl);
  if (!server) return <Redirect href="/connect" />;
  return <SignInStep server={server} serverName={serverName} reconnectId={reconnect} />;
}
