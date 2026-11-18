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
 * `/web/connect?oidc=1` with the finished sign-in in an HttpOnly cookie on its own
 * origin, and the connect screen trades it for a session (`finishOidcSignIn`). A cookie
 * is the whole hand-over, so only the player the server serves signing in to its own
 * server (`onlyOwnServer(servedOrigin(), [server])`) can offer it: never the app, the
 * Metro dev server, or a player hosted on another origin. The return is a page load, so
 * nothing the flow held in memory comes back with it: what the flow was for (a grown-up's
 * pass through kids mode, "Add someone", a signed-out visit's book) goes through this tab's
 * `sessionStorage` instead (`oidc-intent.ts`, fe#310).
 */

// The return's own rule lives apart (`oidc-return.ts`), where the root layout reaches it
// without this module's weight.
export { oidcReturnOnLoad, oidcReturnOrigin } from './oidc-return';

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
 * sign in again: the finish can't be retried (the cookie went with the first try).
 */
export function oidcFinishText(e: unknown, t: TFunction): string {
  if (!(e instanceof ApiError)) return t('connect.oidc.errors.reach');
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
  return t('connect.oidc.errors.failed');
}

/**
 * Finish a single sign-on on the served player's own server (`origin`): `POST
 * /auth/oidc/finish` (the server's cookie goes with it, same origin) with the server's
 * name read alongside, then `finishConnect` as for a pairing link's exchange, ending on the
 * book the flow was opening before the trip and re-pairing the connection a reconnect left
 * with (`takeOidcResumed`; spent by a failed finish too). Resolves null once the flow
 * has moved on, else why it failed in words (`oidcFinishText`; a session this device then
 * couldn't keep, `notKept`, as the sign-in is spent). `live`: whether the connect screen is
 * still up. A session that answers once it has gone, or that `finishConnect` did not store,
 * is signed out again (best effort), never kept: nothing would use it, and it would stay on
 * the server as a device (fe#310).
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
): Promise<string | null> {
  const { book, reconnectId } = takeOidcResumed(origin);
  // A reconnect's finish goes out with its own proxy headers, as its password sign-in
  // would (`connectClientFor(server, _, reconnectId)`), never another person's.
  const { client, proxy: carried } = connectClientFor(origin, undefined, reconnectId);
  // Read before the answer: `settleOidcPass` spends it.
  const expected = oidcPassTag();
  let session: AuthSession;
  let info: ServerInfo | null;
  try {
    [session, info] = await Promise.all([
      client.oidcFinish(getDeviceName(), expected),
      client.serverInfo().catch(() => null),
    ]);
  } catch (e) {
    // A 400 to a finish that named a tag: a server from before the tag, refusing the field.
    const message =
      expected && e instanceof ApiError && e.status === 400
        ? t('connect.oidc.errors.needsUpdate')
        : oidcFinishText(e, t);
    if (settleOidcPass(null) === 'none') return message;
    toast({ title: message });
    return null;
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
    // A server that knows the request's tag never answers it with a session it doesn't echo,
    // and one from before the tag refuses the request (above): this is neither's answer.
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
    return t('connect.oidc.errors.notKept');
  }
}
