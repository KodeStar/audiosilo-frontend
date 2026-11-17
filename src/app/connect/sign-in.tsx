import { Redirect } from 'expo-router';

import {
  peekInviteCode,
  peekReconnect,
  takeInviteCode,
  takeReconnect,
  useHandoff,
} from '@/components/connect/invite-handoff';
import { SignInStep } from '@/components/connect/sign-in-step';
import { parseConnectBook } from '@/lib/paths';
import { useRouteParams } from '@/lib/route-params';
import { useSession } from '@/stores/session';

/**
 * `/connect/sign-in`, reached mid-connect with the server being connected to in
 * `pendingServerUrl` (the first step, or the reconnect banner, which hands over in memory
 * the connection it re-pairs: `holdReconnect`, never a route param, since a link opens this
 * route and must not name the connection a sign-in replaces, fe#298). The address and the
 * reconnect are read once, when the screen opens: signing in clears the address, and the
 * screen must not bounce back to the first step while the flow moves on to "Your library is
 * ready.". A scanned or pasted invite link hands its code along (`holdInvite`), and the step
 * signs in with it at once. Both are read as the screen renders and taken once it is on
 * screen, never in the render: on the web the first render of this route can be thrown away
 * and run again while its chunk loads, and a take there left the step that showed with an
 * empty code field. `book` and `path`: the book a signed-out visit was opening, which the
 * sign-in ends on (frontend#129).
 */
export default function SignInRoute() {
  const { serverName, book, path } = useRouteParams<{
    serverName?: string;
    book?: string;
    path?: string;
  }>();
  const { server, code, reconnect } = useHandoff(
    () => {
      const pending = useSession.getState().pendingServerUrl;
      return {
        server: pending,
        code: pending ? peekInviteCode(pending) : undefined,
        reconnect: peekReconnect(pending),
      };
    },
    (read) => {
      takeInviteCode(read.server);
      takeReconnect(read.server);
    },
  );
  if (!server) return <Redirect href="/connect" />;
  return (
    <SignInStep
      server={server}
      serverName={serverName}
      reconnectId={reconnect}
      initialCode={code}
      book={parseConnectBook({ book, path }) ?? undefined}
    />
  );
}
