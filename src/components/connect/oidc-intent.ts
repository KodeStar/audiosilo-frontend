import {
  connectForNewProfile,
  kidsConnectAllowed,
  restoreKidsConnectPass,
  resumeConnectIntent,
} from '@/components/profiles/connect-intent';
import { type ConnectBook, connectBookParams, parseConnectBook } from '@/lib/paths';
import { sameUrl } from '@/lib/server-address';

/**
 * What a connect flow was for, carried across a single sign-on's trip to the provider
 * (fe#310). The trip is two full page loads, so nothing in memory survives it: a grown-up's
 * pass through kids mode, "Add someone" and a signed-out visit's book would all be lost, and
 * the return would be turned away by kids mode, sign in as the person listening, or end on
 * the library. The sign-in step writes them to this tab's `sessionStorage` as it leaves
 * (`holdOidcIntent`); the connect flow's layout takes them once as it opens on the return
 * (`takeOidcIntent`). Only script on the player's own origin writes
 * there, never a link.
 *
 * The connection a reconnect re-pairs goes too, with the address its sign-in step signed in
 * through (the in-memory hold's, `holdReconnect`): a server reset at a home address keeps
 * the dead connection unless the sign-in names it (`staleIdentities`), so without it the
 * reconnect banner would keep asking. Only this tab's own intent carries it, never the
 * return's address (a `?reconnect=` there does nothing, fe#298), and it is given to the
 * finish only for the server the return is at (`takeOidcReconnect`) and used only once the
 * server answered with a session.
 *
 * A trip abandoned at the provider leaves its intent in the tab, and a later page load of
 * `/connect?oidc=1` (typed, from the history) would take it as its own: a grown-up's pass
 * through kids mode left behind must not open the flow for a child. So the pass is never put
 * back by the address alone: it waits on the sign-in's finish, and comes back only when the
 * server answers with a session (`settleOidcPass`); until then the layout runs the flow's
 * first step, which only finishes the sign-in, and kids mode takes the flow back when it
 * fails. The intent is also stamped and lives only as long as the server lets a sign-in's
 * trip take (`MAX_AGE_MS`, its `FlowMaxAge`), and the flow's layout drops it as the flow is
 * left (`dropOidcIntent`).
 */

const KEY = 'audiosilo.oidcIntent';

/** How long a held intent stays good: the server's own limit on a trip to the provider
 * (`oidc.FlowMaxAge`, ten minutes), with a minute's slack. A return after that can't sign in. */
export const MAX_AGE_MS = 11 * 60_000;

/** A reconnect's sign-in: the connection it re-pairs (`id`) and the address it signed in
 * through (`server`). */
export type OidcReconnect = { server: string; id: string };

/** The flow's intent as it left for the provider. */
export type OidcIntent = {
  newPerson: boolean;
  grownUpFromKids: boolean;
  book?: ConnectBook;
  reconnect?: OidcReconnect;
};

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    // A browser that refuses storage (some private modes) carries nothing.
    return null;
  }
}

/** The page is leaving for the provider: keep what the flow is for, `book`, the book a
 * signed-out visit was opening, and `reconnect`, the connection a reconnect re-pairs (the
 * sign-in step's own). */
export function holdOidcIntent(book?: ConnectBook, reconnect?: OidcReconnect): void {
  const held = {
    at: Date.now(),
    newPerson: connectForNewProfile(),
    grownUpFromKids: kidsConnectAllowed(),
    ...(book ? { book: connectBookParams(book) } : {}),
    ...(reconnect ? { reconnect: { server: reconnect.server, id: reconnect.id } } : {}),
  };
  try {
    storage()?.setItem(KEY, JSON.stringify(held));
  } catch {
    // Full or refused: the return then starts with no intent, as before.
  }
}

/**
 * The intent held before the trip, taken (read and removed) as the connect flow opens on a
 * page load: what it was when this load is the provider's return (`returning`) and it was
 * held within `MAX_AGE_MS`, else null. Either way it is gone, so a trip abandoned at the
 * provider leaves nothing for a later flow.
 */
export function takeOidcIntent(returning: boolean): OidcIntent | null {
  const s = storage();
  let raw: string | null = null;
  try {
    raw = s?.getItem(KEY) ?? null;
    s?.removeItem(KEY);
  } catch {
    return null;
  }
  if (!returning || !raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const age = typeof v.at === 'number' ? Date.now() - v.at : NaN;
    if (!(age >= 0 && age <= MAX_AGE_MS)) return null;
    const b = v.book as Record<string, unknown> | undefined;
    const book = b ? parseConnectBook({ book: b.book as string, path: b.path as string }) : null;
    const r = v.reconnect as Record<string, unknown> | undefined;
    const reconnect =
      typeof r?.server === 'string' && typeof r.id === 'string' && r.server && r.id
        ? { server: r.server, id: r.id }
        : null;
    return {
      newPerson: v.newPerson === true,
      grownUpFromKids: v.grownUpFromKids === true,
      ...(book ? { book } : {}),
      ...(reconnect ? { reconnect } : {}),
    };
  } catch {
    return null;
  }
}

/** The book the returned sign-in ends on (`resumeOidcIntent`), until the finish takes it. */
let resumedBook: ConnectBook | undefined;

/** The reconnect the returned sign-in re-pairs (`resumeOidcIntent`), until the finish takes
 * it. */
let resumedReconnect: OidcReconnect | undefined;

/** Tells the layout that the pass it holds kids mode back for is settled (`settleOidcPass`);
 * null while none waits. */
let passSettled: (() => void) | null = null;

/**
 * Put the taken intent back (the layout, once the profiles are read): who the flow signs in
 * (`resumeConnectIntent`), and the book and the reconnect for the finish (`takeOidcBook`,
 * `takeOidcReconnect`). A grown-up's pass
 * through kids mode is not put back here: it waits on the sign-in's finish
 * (`settleOidcPass`). True while one waits, and the layout then runs the flow's first step
 * (which only finishes the sign-in) without it; `onSettled` is called once, when it is given
 * or not.
 */
export function resumeOidcIntent(held: OidcIntent, onSettled: () => void): boolean {
  resumedBook = held.book;
  resumedReconnect = held.reconnect;
  const waits = resumeConnectIntent(held);
  passSettled = waits ? onSettled : null;
  return waits;
}

/**
 * The returned sign-in's finish answered (`finishOidcSignIn`): the pass that waited on it is
 * `granted` (the server gave a session: the grown-up did sign in) or not (no sign-in to
 * finish, as when the address was typed after a trip abandoned at the provider), and the
 * layout is told. Whether one waited.
 */
export function settleOidcPass(granted: boolean): boolean {
  const settled = passSettled;
  if (!settled) return false;
  passSettled = null;
  if (granted) restoreKidsConnectPass();
  settled();
  return true;
}

/** The book the returned sign-in ends on, taken once (`finishOidcSignIn`). */
export function takeOidcBook(): ConnectBook | undefined {
  const book = resumedBook;
  resumedBook = undefined;
  return book;
}

/** The connection the returned sign-in re-pairs, taken once (`finishOidcSignIn`): only when
 * its sign-in step signed in through `origin`, the server the return is at; any other
 * server's sign-in is no re-pair of it. */
export function takeOidcReconnect(origin: string): string | undefined {
  const held = resumedReconnect;
  resumedReconnect = undefined;
  return held && sameUrl(held.server, origin) ? held.id : undefined;
}

/** The connect flow was left (its layout's cleanup): an intent still held in the tab (a trip
 * abandoned at the provider, the page then restored from the browser's cache), a book or a
 * reconnect nothing took and a pass still waiting go with it. */
export function dropOidcIntent(): void {
  resumedBook = undefined;
  resumedReconnect = undefined;
  passSettled = null;
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Refused storage holds nothing.
  }
}
