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
