import {
  connectForNewProfile,
  kidsConnectAllowed,
  restoreKidsConnectPass,
  resumeConnectIntent,
} from '@/components/profiles/connect-intent';
import { type ConnectBook, connectBookParams, parseConnectBook } from '@/lib/paths';
import { randomBytes, toHex } from '@/lib/random';
import { sameOrigin } from '@/lib/same-origin';

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
 * finish only for the server the return is at (`takeOidcResumed`) and used only once the
 * server answered with a session.
 *
 * A trip abandoned at the provider leaves its intent in the tab, and a later page load of
 * `/connect?oidc=1` (typed, from the history) would take it as its own: a grown-up's pass
 * through kids mode left behind must not open the flow for a child. So the pass is never put
 * back by the address alone: it waits on the sign-in's finish (`settleOidcPass`); until then
 * the layout runs the flow's first step, which only finishes the sign-in, and kids mode takes
 * the flow back when it fails. Nor by any session: with the provider still signed in, the
 * server's start URL typed in this tab finishes a sign-in too (audiosilo#202). So the intent
 * holds a random tag (`tag`) the sign-in step sends to the server's start
 * (`oidcStartUrl(tag)`); the server carries it through the provider and echoes it on the
 * finish of the sign-in that trip completed, once (`AuthSession.intent`), and the pass comes
 * back only on this tab's own tag. The finish also names the tag a waiting pass expects
 * (`oidcPassTag`, the request's `intent`), so the server refuses any other sign-in before it
 * makes a session (403 `oidc_intent_mismatch`). A session with no tag back (an older server,
 * which ignores the request's): no pass, and the finish signs the session out again. The
 * intent is also stamped and lives only as long as the server lets a sign-in's trip take
 * (`MAX_AGE_MS`, its `FlowMaxAge`), and the flow's layout drops it as the flow is left
 * (`dropOidcIntent`). So does the server's own connect page (its `connect.js`, same origin)
 * when a trip ends there with no sign-in (`#oidc=<reason>`): it removes `KEY` too, so keep the
 * name in step with it.
 */

const KEY = 'audiosilo.oidcIntent';

/** How long a held intent stays good: the server's own limit on a trip to the provider
 * (`oidc.FlowMaxAge`, ten minutes). A return after that can't sign in. */
export const MAX_AGE_MS = 10 * 60_000;

/** A reconnect's sign-in: the connection it re-pairs and the address it signed in through
 * (`holdReconnect`'s pair). */
export type OidcReconnect = { server: string; reconnectId: string };

/** The flow's intent as it left for the provider. `tag`: the random value its trip was
 * started with (`holdOidcIntent`), which only that trip's finish echoes. */
export type OidcIntent = {
  newPerson: boolean;
  grownUpFromKids: boolean;
  book?: ConnectBook;
  reconnect?: OidcReconnect;
  tag?: string;
};

/** A tag as `holdOidcIntent` makes it: 32 random bytes in hex. */
const TAG = /^[0-9a-f]{64}$/;

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
 * sign-in step's own). Returns the trip's new tag for the server's start
 * (`oidcStartUrl`), or undefined when the tab could keep nothing. */
export function holdOidcIntent(book?: ConnectBook, reconnect?: OidcReconnect): string | undefined {
  const store = storage();
  if (!store) return undefined;
  const tag = toHex(randomBytes(32));
  const held = {
    at: Date.now(),
    tag,
    newPerson: connectForNewProfile(),
    grownUpFromKids: kidsConnectAllowed(),
    ...(book ? { book: connectBookParams(book) } : {}),
    ...(reconnect ? { reconnect } : {}),
  };
  try {
    store.setItem(KEY, JSON.stringify(held));
    return tag;
  } catch {
    // Full or refused: the return then starts with no intent, as before.
    return undefined;
  }
}

/**
 * The intent held before the trip, taken (read and removed) as the connect flow opens on a
 * page load: what it was when this load is the provider's return (`returning`) and it was
 * held within `MAX_AGE_MS`, else null. Either way it is gone, so a trip abandoned at the
 * provider leaves nothing for a later flow. The layout reads it as it renders
 * (`peekOidcIntent`) and takes it once it is on screen (`useHandoff`): a first render that
 * is thrown away and run again must still find it.
 */
export function takeOidcIntent(returning: boolean): OidcIntent | null {
  const held = peekOidcIntent(returning);
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Refused storage holds nothing.
  }
  return held;
}

/** `takeOidcIntent`'s answer, left in the tab (`useHandoff`). */
export function peekOidcIntent(returning: boolean): OidcIntent | null {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(KEY) ?? null;
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
    const [server, reconnectId] = [r?.server, r?.reconnectId];
    const reconnect =
      typeof server === 'string' && server && typeof reconnectId === 'string' && reconnectId
        ? { server, reconnectId }
        : null;
    return {
      newPerson: v.newPerson === true,
      grownUpFromKids: v.grownUpFromKids === true,
      ...(book ? { book } : {}),
      ...(reconnect ? { reconnect } : {}),
      ...(typeof v.tag === 'string' && TAG.test(v.tag) ? { tag: v.tag } : {}),
    };
  } catch {
    return null;
  }
}

/** What the returned sign-in's finish takes (`resumeOidcIntent`), until it does. */
let resumed: Pick<OidcIntent, 'book' | 'reconnect'> = {};

/** The pass the layout holds kids mode back for, null while none waits: `settled` tells the
 * layout it is settled (`settleOidcPass`), and `tag` is the trip's it left with (none: nothing
 * echoes it). */
let pass: { settled: () => void; tag?: string } | null = null;

/**
 * Put the taken intent back (the layout, once the profiles are read): who the flow signs in
 * (`resumeConnectIntent`), and the book and the reconnect for the finish
 * (`takeOidcResumed`). A grown-up's pass through kids mode is not put back here: it waits on
 * the sign-in's finish
 * (`settleOidcPass`). True while one waits, and the layout then runs the flow's first step
 * (which only finishes the sign-in) without it; `onSettled` is called once, when it is given
 * or not.
 */
export function resumeOidcIntent(held: OidcIntent, onSettled: () => void): boolean {
  resumed = { book: held.book, reconnect: held.reconnect };
  const waits = resumeConnectIntent(held);
  pass = waits ? { settled: onSettled, tag: held.tag } : null;
  return waits;
}

/** The tag the waiting pass expects its sign-in's finish to carry, for the finish's request
 * (`client.oidcFinish`'s `intent`); undefined with no pass waiting, or one that left with no
 * tag. */
export function oidcPassTag(): string | undefined {
  return pass?.tag;
}

/** What `settleOidcPass` did: no pass waited, it was given back, or it was refused. */
export type OidcPassAnswer = 'none' | 'given' | 'refused';

/**
 * The returned sign-in's finish answered (`finishOidcSignIn`) with `session`, or with none
 * (null: no sign-in to finish, as when the address was typed after a trip abandoned at the
 * provider). The pass that waited on it is given back only when the session echoes this
 * trip's own tag (`intent`): the grown-up signed in on the trip this tab started. A session
 * with no tag, or another, is an older server's (a current one refuses the finish itself,
 * `oidcPassTag`), where it may be someone's sign-in the start URL typed later completed (a
 * provider still signed in): refused. The layout is told either way, and the tag is spent.
 */
export function settleOidcPass(session: { intent?: string } | null): OidcPassAnswer {
  const waiting = pass;
  pass = null;
  if (!waiting) return 'none';
  const given = !!waiting.tag && session?.intent === waiting.tag;
  if (given) restoreKidsConnectPass();
  waiting.settled();
  return given ? 'given' : 'refused';
}

/** The book the returned sign-in at `origin` ends on and the connection it re-pairs, taken
 * once (`finishOidcSignIn`). The reconnect only when its step signed in through `origin`, by
 * the rule that offered single sign-on there (`onlyOwnServer`). */
export function takeOidcResumed(origin: string): { book?: ConnectBook; reconnectId?: string } {
  const { book, reconnect } = resumed;
  resumed = {};
  return {
    book,
    reconnectId:
      reconnect && sameOrigin(reconnect.server, { origin }) ? reconnect.reconnectId : undefined,
  };
}

/** The connect flow was left (its layout's cleanup): an intent still held in the tab (a trip
 * abandoned at the provider, the page then restored from the browser's cache), a book or a
 * reconnect nothing took and a pass still waiting go with it. */
export function dropOidcIntent(): void {
  resumed = {};
  pass = null;
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Refused storage holds nothing.
  }
}
