import { useMemo } from 'react';
import { Platform } from 'react-native';
import { create } from 'zustand';

import {
  type AddressedConnection,
  addressKind,
  type AddressKind,
  isOwnAddress,
} from '@/lib/server-address';
import { useSession } from '@/stores/session';

/**
 * Which address each connection's requests go to right now (home and away addresses,
 * capability `addresses`). The pick is IN MEMORY only, `{ [connectionId]: url }`, set by
 * the address runner (`src/api/address-runner.ts`, native only) after probing the home
 * address; absent means the connection's `serverUrl`. Every client is built from
 * `effectiveUrl` (`ApiProvider` and `resolveClient`, the only two places that build a
 * connection's client), so media URLs follow too.
 *
 * Web never switches: the served player is same-origin with the address it was opened
 * at, so `effectiveUrl` is always `serverUrl` there.
 */
type AddressRouteState = { picks: Record<string, string> };

export const useAddressRoute = create<AddressRouteState>(() => ({ picks: {} }));

/** Set (or with null, drop) a connection's pick. A no-op when nothing changes, so the
 * clients are only rebuilt for a real switch. */
export function setAddressPick(connectionId: string, url: string | null): void {
  const { picks } = useAddressRoute.getState();
  if (url === null) {
    if (!(connectionId in picks)) return;
    const { [connectionId]: _drop, ...rest } = picks;
    useAddressRoute.setState({ picks: rest });
    return;
  }
  if (picks[connectionId] === url) return;
  useAddressRoute.setState({ picks: { ...picks, [connectionId]: url } });
}

/** The address a connection uses given its `pick`: the pick while that is still one
 * of its own addresses (they can change under a pick), else `serverUrl`. Always
 * `serverUrl` on web. */
export function pickedUrl(c: AddressedConnection, pick: string | undefined): string {
  if (Platform.OS === 'web') return c.serverUrl;
  return pick && isOwnAddress(pick, c) ? pick : c.serverUrl;
}

/** The address a connection's requests go to right now. */
export function effectiveUrl(c: AddressedConnection): string {
  return pickedUrl(c, useAddressRoute.getState().picks[c.id]);
}

/** How long `networkChecked` waits at most: the check is two native reads, and nothing
 * the app does on coming back may hang on one that never answers. */
export const NETWORK_CHECK_MAX_MS = 2_000;

/** The address runner's check of the network after the app was away (null: none due). */
let networkCheck: { promise: Promise<void>; resolve: () => void } | null = null;

/** The app left the foreground: the device may join another network before it is back,
 * so the next foreground's requests wait for `endNetworkCheck`. Runner-only. */
export function beginNetworkCheck(): void {
  if (networkCheck) return;
  let resolve = () => {};
  const promise = new Promise<void>((r) => (resolve = r));
  networkCheck = { promise, resolve };
}

/** The runner has read the network after the app came back (and dropped the home
 * addresses when the device moved), or stopped. Runner-only. */
export function endNetworkCheck(): void {
  networkCheck?.resolve();
  networkCheck = null;
}

/**
 * Resolves once the address runner has checked the network after the app came back to
 * the foreground (at once when no check is due, on web, or after `NETWORK_CHECK_MAX_MS`).
 * Whatever sends requests on the foreground event awaits it first: the device may have
 * changed network while suspended, and a home address checked on the previous network
 * must be dropped before the token goes out (`useAppResume`'s refresh, the place
 * reconcile). Safe to call in any order with the runner's own foreground handler: the
 * check is due from the moment the app leaves.
 */
export function networkChecked(): Promise<void> {
  const check = networkCheck;
  if (!check) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, NETWORK_CHECK_MAX_MS);
    void check.promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** The address a connection is using now and which of its addresses that is. */
export type ActiveAddress = { url: string; kind: AddressKind };

/**
 * The address the connection `connectionId` is using right now, and whether that is its
 * home or away address or the one it was paired with (`paired`: no addresses known, or
 * the paired URL is neither). Re-renders when the player switches. `{ url: '', kind:
 * 'paired' }` for an unknown connection. For the Account and Connect screens ("Using your
 * home address"); labels are `ADDRESS_KIND_LABEL` / `ADDRESS_IN_USE_LABEL`.
 */
export function useActiveAddress(connectionId: string): ActiveAddress {
  const conn = useSession((s) => s.connections.find((c) => c.id === connectionId));
  const pick = useAddressRoute((s) => s.picks[connectionId]);
  return useMemo(() => {
    if (!conn) return { url: '', kind: 'paired' };
    const url = pickedUrl(conn, pick);
    return { url, kind: addressKind(url, conn.addresses) };
  }, [conn, pick]);
}

/** The i18n key naming each kind of address ("Home address"). */
export const ADDRESS_KIND_LABEL = {
  home: 'addresses.home',
  away: 'addresses.away',
  paired: 'addresses.paired',
} as const satisfies Record<AddressKind, string>;

/** The i18n key saying which address is in use ("Using your home address"). */
export const ADDRESS_IN_USE_LABEL = {
  home: 'addresses.usingHome',
  away: 'addresses.usingAway',
  paired: 'addresses.usingPaired',
} as const satisfies Record<AddressKind, string>;
