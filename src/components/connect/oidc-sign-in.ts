import type { TFunction } from 'i18next';

import { ApiClient, ApiError, apiErrorKind } from '@/api/client';
import { connectClientFor } from '@/api/connect-client';
import type { AuthSession, ServerInfo } from '@/api/types';
import { toast } from '@/components/ui/toast';
import { getDeviceName } from '@/lib/device';
import { useSession } from '@/stores/session';

import { finishConnect } from './finish-connect';
import { oidcPassTag, settleOidcPass, takeOidcResumed } from './oidc-intent';
import { sharedRefusalText } from './sign-in-error';

/**
 * Single sign-on (OpenID Connect, server#235) in the web player. The sign-in step offers
 * "Sign in with <name>" as a full page load of the server's `/auth/oidc/start` (the
 * provider, then the server's callback); the server lands the browser on
 * `/web/connect?oidc=1&flow=<key>` with the finished sign-in in an HttpOnly cookie of that
 * flow's on its own origin, and the connect screen trades it for a session
 * (`finishOidcSignIn`, naming the flow, so two tabs back at once each finish their own). A cookie
 * is the whole hand-over, so only the player the server serves signing in to its own
 * server (`onlyOwnServer(servedOrigin(), [server])`) can offer it: never the app, the
 * Metro dev server, or a player hosted on another origin. The return is a page load, so
 * nothing the flow held in memory comes back with it: what the flow was for (a grown-up's
 * pass through kids mode, "Add someone", a signed-out visit's book) goes through this tab's
 * `sessionStorage` instead (`oidc-intent.ts`, fe#310).
 */

// The return's own rule lives apart (`oidc-return.ts`), where the root layout reaches it
// without this module's weight.
export { oidcFlowKey, oidcReturnCleared, oidcReturnOnLoad, oidcReturnOrigin } from './oidc-return';

/** The sign-in step's button while the server's `oidc` capability is on: the provider's
 * name ("Sign in with Keycloak"), '' when it sent none (the button then names single
 * sign-on itself), and null while it is off or the server is older. */
export function oidcButtonName(info: ServerInfo | null): string | null {
  if (info?.capabilities?.oidc !== true) return null;
  return info.auth?.oidc?.name?.trim() ?? '';
}

/**
 * A failed finish in words of our own: a 429's wait and a disabled member as every
 * sign-in words them (`sharedRefusalText`); no
 * finished sign-in in this browser (`oidc_no_sign_in`: a reload, or a browser keeping the
 * cookie back); one spent or past its minute (`oidc_sign_in_expired`); one that is not the
 * trip a kids-mode pass waits on (`oidc_intent_mismatch`); no answer from
 * the server; anything else (a 400, a 5xx) as a sign-in that didn't finish. Each says to
 * sign in again, unless the screen offers the same finish again (`retry`, `oidcRetryWait`):
 * then no answer, a 408 and a 5xx say to try again. A reload never sends a finish again (the
 * return's params leave the address before it goes): only the screen's Try again does,
 * from memory. The server clears the cookie with each refusal of the sign-in itself, and
 * keeps it for the rest of its minute on a 429, a 400 and (server#406) a 500, which a new
 * sign-in never meets: its return names its own flow.
 */
export function oidcFinishText(e: unknown, t: TFunction, retry = false): string {
  if (!(e instanceof ApiError))
    return t(retry ? 'connect.oidc.errors.reachRetry' : 'connect.oidc.errors.reach');
  const shared = sharedRefusalText(e, t);
  if (shared !== undefined) return shared;
  switch (apiErrorKind(e)) {
    case 'oidc_no_sign_in':
      return t('connect.oidc.errors.noSignIn');
    case 'oidc_sign_in_expired':
      return t('connect.oidc.errors.expired');
    case 'oidc_intent_mismatch':
      return t('connect.oidc.errors.notThisTrip');
  }
  if (retry && (e.status >= 500 || e.status === 408)) return t('connect.oidc.errors.failedRetry');
  return t('connect.oidc.errors.failed');
}

/** How long the server keeps a finished sign-in for its finish (its done cookie, the
 * server's `oidcDoneTTL`): a retry can't outlive it. */
export const OIDC_DONE_MS = 60_000;

/**
 * How long before a failed finish may go again (ms), or undefined when it may not: the
 * server kept the sign-in (its done cookie) for no answer at all, a 408 (a proxy's timeout,
 * as `pairFailure` and `isRefusedForGood` read it), a 5xx (server#406: nothing was spent)
 * and a 429 (after its `Retry-After`, none being no wait). Never a refusal of the sign-in (a
 * 401, a 403, a 400): the cookie is gone, or the request itself is wrong. None either once
 * the done cookie's minute is over (`leftMs`, what is left of `OIDC_DONE_MS`), nor for a wait
 * that outlasts it (a lockout's 15 minutes): the sign-in can't outlive it.
 */
export function oidcRetryWait(e: unknown, leftMs = OIDC_DONE_MS): number | undefined {
  if (leftMs <= 0) return undefined;
  if (!(e instanceof ApiError)) return 0;
  if (e.status >= 500 || e.status === 408) return 0;
  if (e.status !== 429) return undefined;
  const ms = (e.retryAfterSeconds ?? 0) * 1000;
  return ms < leftMs ? ms : undefined;
}

/** The same finish sent again (`finishOidcSignIn`'s, with its flow, book and reconnect, all
 * in memory only), offered as Try again once `waitMs` has passed and until `doneBy` (epoch
 * ms: the done cookie's minute from the provider's return, `OIDC_DONE_MS`), when the server
 * holds the sign-in no more. */
export type OidcFinishRetry = {
  waitMs: number;
  doneBy: number;
  run: () => Promise<OidcFinishFailure | null>;
};

/** A finish that failed on the screen: why, in words, and the retry the server left room
 * for (`oidcRetryWait`), none once the sign-in is refused. */
export type OidcFinishFailure = { message: string; retry?: OidcFinishRetry };

/**
 * Finish a single sign-on on the served player's own server (`origin`): `POST
 * /auth/oidc/finish` (the server's cookie goes with it, same origin; `flow`, the key the
 * return named, picks this tab's sign-in among the browser's, `oidcFlowKey`) with the server's
 * name read alongside, then `finishConnect` as for a pairing link's exchange, ending on the
 * book the flow was opening before the trip and re-pairing the connection a reconnect left
 * with (`takeOidcResumed`, taken once: a retry keeps them). Resolves null once the flow
 * has moved on, else why it failed in words (`oidcFinishText`; a session this device then
 * couldn't keep, `notKept`, as the sign-in is spent) and, when the server kept the sign-in
 * (`oidcRetryWait`: no answer, a 408, a 5xx, a 429, within the done cookie's minute) and no
 * pass waits, the same finish to send again (`retry`). The flow's key lives in that closure
 * only, never the address, storage or a log, and goes with it once the finish succeeds or is
 * refused. `live`: whether
 * the connect screen is still up. A session that answers once it has gone, or that
 * `finishConnect` did not store, is signed out again (best effort), never kept: nothing would
 * use it, and it would stay on the server as a device (fe#310).
 *
 * A grown-up's pass through kids mode that the trip left with waits on this answer
 * (`settleOidcPass`): given back only with a session that echoes the trip's own tag
 * (`intent`, audiosilo#202), before `finishConnect`. Otherwise it is not, kids mode takes
 * the flow back (the connect layout), and the reason goes over it as a toast, since the
 * screen that would say it is gone (null: the flow moved on). The finish names the tag the
 * pass expects (`oidcPassTag`), so the server refuses any other sign-in itself and makes no
 * session (403 `oidc_intent_mismatch`: the start URL typed in this tab while the provider is
 * still signed in). A server with single sign-on from before the tag can't tell the trips
 * apart: it refuses a body naming one (400, its bodies take no field it doesn't know) and
 * makes no session, and the toast says the server needs updating (`needsUpdate`: signing in
 * again would end the same way). A session that came back without the tag all the same is
 * treated alike: signed out again, since kept it could add someone to the kids device with
 * no grown-up's say.
 */
export async function finishOidcSignIn(
  origin: string,
  t: TFunction,
  live: () => boolean,
  flow?: string,
): Promise<OidcFinishFailure | null> {
  // The provider's return loaded this page just now: the done cookie's minute runs from here.
  const doneBy = Date.now() + OIDC_DONE_MS;
  const { book, reconnectId } = takeOidcResumed(origin);
  // A reconnect's finish goes out with its own proxy headers, as its password sign-in
  // would (`connectClientFor(server, _, reconnectId)`), never another person's.
  const { client, proxy: carried } = connectClientFor(origin, undefined, reconnectId);
  // Read before the answer: `settleOidcPass` spends it.
  const expected = oidcPassTag();
  const attempt = async (): Promise<OidcFinishFailure | null> => {
    let session: AuthSession;
    let info: ServerInfo | null;
    try {
      [session, info] = await Promise.all([
        client.oidcFinish(getDeviceName(), expected, flow),
        client.serverInfo().catch(() => null),
      ]);
    } catch (e) {
      // A pass waiting on this answer is refused now (kids mode takes the flow back, so no
      // screen is left to try again from), and the reason goes over it.
      if (settleOidcPass(null) !== 'none') {
        // A 400 to a finish that named a tag: a server from before the tag, refusing the field.
        const why =
          expected && e instanceof ApiError && e.status === 400
            ? t('connect.oidc.errors.needsUpdate')
            : oidcFinishText(e, t);
        toast({ title: why });
        return null;
      }
      const waitMs = oidcRetryWait(e, doneBy - Date.now());
      const message = oidcFinishText(e, t, waitMs !== undefined);
      return waitMs === undefined
        ? { message }
        : { message, retry: { waitMs, doneBy, run: attempt } };
    }
    // A session nothing keeps is signed out again (best effort): it would stay on the server
    // as a device.
    const signOut = () =>
      void new ApiClient(origin, session.token, undefined, undefined, undefined, carried)
        .logout()
        .catch(() => {});
    if (!live()) {
      settleOidcPass(null);
      signOut();
      return null;
    }
    if (settleOidcPass(session) === 'refused') {
      signOut();
      // A server that knows the request's tag never answers it with a session it doesn't
      // echo, and one from before the tag refuses the request (above): this is neither's
      // answer.
      toast({
        title: t(expected ? 'connect.oidc.errors.needsUpdate' : 'connect.oidc.errors.notThisTrip'),
      });
      return null;
    }
    try {
      await finishConnect({
        serverUrl: origin,
        session,
        name: info?.name,
        reconnectId,
        book,
        carried,
      });
      return null;
    } catch {
      // Not stored (refused before `setSession`, or the store failed): nothing will use it.
      if (!useSession.getState().connections.some((c) => c.token === session.token)) signOut();
      return { message: t('connect.oidc.errors.notKept') };
    }
  };
  return attempt();
}
