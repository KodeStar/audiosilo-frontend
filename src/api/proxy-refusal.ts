import { create } from 'zustand';

import { ownSetInUse, type ProxySets, type SignInProxySet } from '@/lib/proxy-headers';
import { useSession } from '@/stores/session';

import type { ProxyRefusalStatus } from './client';

/**
 * The signed-in connections a proxy in front of their server is turning away now (fe#295):
 * a request through the connection's client answered with the proxy's own 401 or 403
 * (`ApiError.fromProxy`), and the server itself has answered none since. One episode per
 * connection: it starts at the first refusal and ends at the next answer the server gave past
 * its token check (a success, or its own error but a 401, to a request carrying the token the
 * connection holds: the proxy let it through; never a public route's, `ApiClient`'s
 * `onProxyAnswer`), so the shell says it once for the whole run of refusals
 * (`ProxyRefusedBanner`), never once per request. Not a sign-out and not a reconnect: the
 * server never judged the token, and the way past is the proxy headers (the Account page's
 * card). In memory only: a launch starts with none, and a
 * connection signed out or removed takes its episode with it (the provider's
 * `onConnectionRemoved`), and one another tab's identity migration renamed carries it to its
 * new id (`moveProxyRefusal`). Each episode keeps its refusals' status: a 401 once any was
 * (the server's own refusal of the token may be behind it, its mark dropped: WS-401-MARK, and
 * Sign in again is offered), else a 403, which no sign-in gets past.
 */
export const useProxyRefusals = create<{
  refused: Readonly<Record<string, ProxyRefusalStatus>>;
}>(() => ({
  refused: {},
}));

/** What one answer through `connectionId`'s client said of its proxy (`ApiClient`'s
 * `onProxyAnswer`): a refusal's status starts the connection's episode (or makes a 403
 * episode a 401 one), an answer of the server's own ends it (and tells
 * `onProxyRefusalsOver`). Runs on every such answer, so one that changes nothing returns at
 * once. */
export function noteProxyAnswer(connectionId: string, refused: ProxyRefusalStatus | false): void {
  const now = useProxyRefusals.getState().refused;
  const was = now[connectionId];
  if (refused) {
    if (was === 401 || was === refused) return;
    useProxyRefusals.setState({ refused: { ...now, [connectionId]: refused } });
    return;
  }
  if (was === undefined) return;
  const { [connectionId]: _ended, ...rest } = now;
  useProxyRefusals.setState({ refused: rest });
  refusalsOver(connectionId);
}

const overListeners = new Set<(connectionId: string) => void>();

/** Whether `connectionId` is signed in now: in the list, its token not refused. */
const signedIn = (connectionId: string) =>
  useSession.getState().connections.some((c) => c.id === connectionId && !c.needsReconnect);

/** Tell `onProxyRefusalsOver`'s listeners that `connectionId`'s episode ended; not for one
 * no longer signed in (signed out, removed or needing a sign-in again: nothing to send). */
function refusalsOver(connectionId: string): void {
  if (!signedIn(connectionId)) return;
  for (const listener of overListeners) {
    try {
      listener(connectionId);
    } catch (e) {
      console.warn('[proxy-refusal] listener failed', e);
    }
  }
}

/** Run `listener` with the connection whenever a proxy's refusals of it end (the server
 * itself answered, `noteProxyAnswer`), while it is still signed in: each stored queue sends
 * what the refusals held at once (that connection's only), as after a 429's wait
 * (`onRateLimitOver`), not at its backoff's next try or the next focus. Returns the
 * unsubscribe. */
export function onProxyRefusalsOver(listener: (connectionId: string) => void): () => void {
  overListeners.add(listener);
  return () => {
    overListeners.delete(listener);
  };
}

/** Another tab's identity migration renamed `from` to `to` (the provider's
 * `onConnectionRenamed`): its episode goes on under `to`, where its client's answers now end
 * it (`connection-clients.ts` notes them under the id now), and the banner on `to` keeps the
 * notice. Ended instead, with nothing to tell, when `to` is not signed in. */
export function moveProxyRefusal(from: string, to: string): void {
  const now = useProxyRefusals.getState().refused;
  const status = now[from];
  if (!status) return;
  const { [from]: _moved, ...rest } = now;
  useProxyRefusals.setState({ refused: signedIn(to) ? { ...rest, [to]: status } : rest });
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
  refused: Readonly<Record<string, ProxyRefusalStatus>>,
  sets: ProxySets,
  own: Readonly<Record<string, SignInProxySet>>,
): boolean {
  return refused[connectionId] !== undefined || ownSetInUse(sets, own[connectionId]);
}

/** `needsProxyNotice` for one connection, kept current: a sign-in's own set only while the
 * connection is still signed in, and nothing for one that needs signing in again (the banner's
 * rule: that is the one thing to ask for). */
export function useProxyNotice(connectionId: string | undefined): boolean {
  const refused = useProxyRefusals((s) => s.refused);
  return useSession((s) => {
    if (!connectionId) return false;
    const conn = s.connections.find((c) => c.id === connectionId);
    if (conn?.needsReconnect) return false;
    return needsProxyNotice(connectionId, refused, s.proxySets, conn ? s.signInProxySets : {});
  });
}

/** Tests: no connection refused. */
export function resetProxyRefusalsForTests(): void {
  useProxyRefusals.setState({ refused: {} });
}
