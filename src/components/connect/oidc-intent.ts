import {
  connectForNewProfile,
  kidsConnectAllowed,
  resumeConnectIntent,
} from '@/components/profiles/connect-intent';
import { type ConnectBook, connectBookParams, parseConnectBook } from '@/lib/paths';

/**
 * What a connect flow was for, carried across a single sign-on's trip to the provider
 * (fe#310). The trip is two full page loads, so nothing in memory survives it: a grown-up's
 * pass through kids mode, "Add someone" and a signed-out visit's book would all be lost, and
 * the return would be turned away by kids mode, sign in as the person listening, or end on
 * the library. The sign-in step writes them to this tab's `sessionStorage` as it leaves
 * (`holdOidcIntent`); the connect flow's layout takes them once as it opens on the return
 * (`takeOidcIntent`), before kids mode is told. Only script on the player's own origin writes
 * there, never a link. The connection a reconnect re-pairs is not carried: the same user
 * signing in again re-pairs their connection by the server's id anyway.
 */

const KEY = 'audiosilo.oidcIntent';

/** The flow's intent as it left for the provider. */
export type OidcIntent = { newPerson: boolean; grownUpFromKids: boolean; book?: ConnectBook };

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    // A browser that refuses storage (some private modes) carries nothing.
    return null;
  }
}

/** The page is leaving for the provider: keep what the flow is for, and `book`, the book a
 * signed-out visit was opening (the sign-in step's own). */
export function holdOidcIntent(book?: ConnectBook): void {
  const held = {
    newPerson: connectForNewProfile(),
    grownUpFromKids: kidsConnectAllowed(),
    ...(book ? { book: connectBookParams(book) } : {}),
  };
  try {
    storage()?.setItem(KEY, JSON.stringify(held));
  } catch {
    // Full or refused: the return then starts with no intent, as before.
  }
}

/**
 * The intent held before the trip, taken (read and removed) as the connect flow opens on a
 * page load: what it was when this load is the provider's return (`returning`), else null.
 * Either way it is gone, so a trip abandoned at the provider leaves nothing for a later flow.
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
    const b = v.book as Record<string, unknown> | undefined;
    const book = b ? parseConnectBook({ book: b.book as string, path: b.path as string }) : null;
    return {
      newPerson: v.newPerson === true,
      grownUpFromKids: v.grownUpFromKids === true,
      ...(book ? { book } : {}),
    };
  } catch {
    return null;
  }
}

/** The book the returned sign-in ends on (`resumeOidcIntent`), until the finish takes it. */
let resumedBook: ConnectBook | undefined;

/** Put the taken intent back (the layout, once the profiles are read): the flow's own
 * (`resumeConnectIntent`), and the book for the finish (`takeOidcBook`). */
export function resumeOidcIntent(held: OidcIntent): void {
  resumeConnectIntent(held);
  resumedBook = held.book;
}

/** The book the returned sign-in ends on, taken once (`finishOidcSignIn`). */
export function takeOidcBook(): ConnectBook | undefined {
  const book = resumedBook;
  resumedBook = undefined;
  return book;
}
