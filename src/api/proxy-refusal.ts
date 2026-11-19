import { create } from 'zustand';

import { ownSetInUse, type ProxySets, type SignInProxySet } from '@/lib/proxy-headers';
import { useSession } from '@/stores/session';

/**
 * The signed-in connections a proxy in front of their server is turning away now (fe#295):
 * a request through the connection's client answered with the proxy's own 401 or 403
 * (`ApiError.fromProxy`), and none has succeeded since. One episode per connection: it starts
 * at the first refusal and ends at the next request that succeeds, so the shell says it once
 * for the whole run of refusals (`ProxyRefusedBanner`), never once per request. Not a
 * sign-out and not a reconnect: the server never judged the token, and the way past is the
 * proxy headers (the Account page's card). In memory only: a launch starts with none, and a
 * connection signed out or removed takes its episode with it (the provider's
 * `onConnectionRemoved`).
 */
export const useProxyRefusals = create<{ refused: Readonly<Record<string, true>> }>(() => ({
  refused: {},
}));

/** What one answer through `connectionId`'s client said of its proxy (`ApiClient`'s
 * `onProxyAnswer`): `refused` starts the connection's episode, a success ends it. Runs on
 * every successful request, so a success with nothing refused returns at once. */
export function noteProxyAnswer(connectionId: string, refused: boolean): void {
  const now = useProxyRefusals.getState().refused;
  if (refused === (now[connectionId] === true)) return;
  if (refused) {
    useProxyRefusals.setState({ refused: { ...now, [connectionId]: true } });
    return;
  }
  const { [connectionId]: _ended, ...rest } = now;
  useProxyRefusals.setState({ refused: rest });
}

/**
 * Whether the proxy notice is for `connectionId` (the shell's `ProxyRefusedBanner`, kids
 * mode's line): a proxy is turning its requests away now (`refused`), or it is on its
 * sign-in's own proxy headers (`own`, `signInProxySets`: a kid's account the address's kept
 * set no longer gets past, `setSession`) while that kept set is still the one it stands in for
 * (`ownSetInUse`), so the address's set needs a grown-up to update it.
 */
export function needsProxyNotice(
  connectionId: string,
  refused: Readonly<Record<string, true>>,
  sets: ProxySets,
  own: Readonly<Record<string, SignInProxySet>>,
): boolean {
  return refused[connectionId] === true || ownSetInUse(sets, own[connectionId]);
}

/** `needsProxyNotice` for one connection, kept current: a sign-in's own set only while the
 * connection is still signed in. */
export function useProxyNotice(connectionId: string | undefined): boolean {
  const refused = useProxyRefusals((s) => s.refused);
  return useSession(
    (s) =>
      !!connectionId &&
      needsProxyNotice(
        connectionId,
        refused,
        s.proxySets,
        s.connections.some((c) => c.id === connectionId) ? s.signInProxySets : {},
      ),
  );
}

/** Tests: no connection refused. */
export function resetProxyRefusalsForTests(): void {
  useProxyRefusals.setState({ refused: {} });
}
