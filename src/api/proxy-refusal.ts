import { create } from 'zustand';

import { ownSetInUse } from '@/lib/proxy-headers';
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

/** Whether a proxy is turning `connectionId`'s requests away now. */
export function useProxyRefused(connectionId: string | undefined): boolean {
  return useProxyRefusals((s) => !!connectionId && s.refused[connectionId] === true);
}

/** Whether `connectionId` is on its sign-in's own proxy headers (`signInProxySets`: a kid's
 * account the address's kept set no longer gets past, `setSession`) while that kept set is
 * still the one it stands in for: the address's set needs a grown-up to update it. */
export function useOnOwnProxySet(connectionId: string | undefined): boolean {
  return useSession((s) => {
    const own = connectionId ? s.signInProxySets[connectionId] : undefined;
    return ownSetInUse(s.proxySets, own) && s.connections.some((c) => c.id === connectionId);
  });
}

/** Tests: no connection refused. */
export function resetProxyRefusalsForTests(): void {
  useProxyRefusals.setState({ refused: {} });
}
