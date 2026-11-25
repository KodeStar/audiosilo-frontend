import { appPath, productionWebOrigin } from '@/lib/base-url';
import { firstParam } from '@/lib/paths';

import { clearHeldOidcIntent } from './oidc-intent';

/**
 * Telling a single sign-on's return (`oidc-sign-in.ts`) from any other page load. Its own
 * small module: the root layout runs `endOidcTripOnLoad` as every page loads, and must not
 * pull the connect flow in with it.
 */

/** The served player's return from a single sign-on (`/connect?oidc=1`): its own origin,
 * where the server's cookie is, or null (the app, Metro, another value, or a pairing link,
 * which wins: any `token`, a repeated one's list too). The route, the connect screen and the
 * layout (`oidcReturnOnLoad`) all decide by it, from params as the router hands them over. */
export function oidcReturnOrigin(
  oidc: string | string[] | undefined,
  token?: string | string[],
): string | null {
  return !token && firstParam(oidc) === '1' ? productionWebOrigin() : null;
}

/** The key of the flow a single sign-on's return names (`/connect?oidc=1&flow=<key>`): the
 * finish sends it, so the sign-in it takes is this tab's own when another tab's came back
 * too (server#406). Undefined from a server before the key, or for anything that can be no
 * key (16 base64url characters, as the server makes it). */
export function oidcFlowKey(flow: string | string[] | undefined): string | undefined {
  const key = firstParam(flow);
  return /^[A-Za-z0-9_-]{16}$/.test(key) ? key : undefined;
}

/** The params a single sign-on's return brings, all taken off the address at once (a reload
 * must find none of them to try the finish again). */
export const oidcReturnCleared = { oidc: undefined, flow: undefined } as const;

/** Whether this page load is the server's return from a single sign-on, read from the
 * address itself (`oidcReturnOrigin`'s rule, on the flow's first step: the one route that
 * finishes it, so `?oidc=1` on any other of the flow's routes is no return): the connect
 * flow's layout must know before any route's params reach it, to put back what the flow was
 * for (`peekOidcIntent`). */
export function oidcReturnOnLoad(): boolean {
  if (!productionWebOrigin()) return false;
  const at = globalThis.location;
  if (appPath(at?.pathname ?? '').replace(/\/+$/, '') !== '/connect') return false;
  const q = new URLSearchParams(at?.search ?? '');
  // As the router hands the screen its params (a repeated one is a list): the layout and the
  // screen must agree, or the layout would hold kids mode back for a finish that never runs
  // (`?oidc=1&token=&token=x`: no token here by its first value, a pairing link there).
  const param = (name: string) => {
    const all = q.getAll(name);
    return all.length > 1 ? all : all[0];
  };
  return oidcReturnOrigin(param('oidc'), param('token')) !== null;
}

/**
 * A page load that is not a single sign-on's return ends the trip this tab still holds
 * (`holdOidcIntent`): its intent is dropped, tag and all. Run once as the page loads (the
 * root layout's module, so on every route, before anything renders). The connect flow's
 * layout drops it as it opens or is left, but a trip abandoned at the provider can come back
 * to any page of the player, and its tag must not stay for the server's start URL sent again
 * from the browser's history to complete: the pass a grown-up left with would be given back
 * for it (audiosilo#202). Only the return itself keeps the intent, for the layout to take.
 */
export function endOidcTripOnLoad(): void {
  if (!oidcReturnOnLoad()) clearHeldOidcIntent();
}
