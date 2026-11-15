import type { TFunction } from 'i18next';

import { ApiError, apiErrorKind } from '@/api/client';
import { connectClientFor } from '@/api/connect-client';
import type { AuthSession, ServerInfo } from '@/api/types';
import { servedOrigin } from '@/lib/base-url';
import { getDeviceName } from '@/lib/device';
import { firstParam } from '@/lib/paths';

import { finishConnect } from './finish-connect';
import { sharedRefusalText } from './sign-in-error';

/**
 * Single sign-on (OpenID Connect, server#235) in the web player. The sign-in step offers
 * "Sign in with <name>" as a full page load of the server's `/auth/oidc/start` (the
 * provider, then the server's callback); the server lands the browser on
 * `/web/connect?oidc=1` with the finished sign-in in an HttpOnly cookie on its own
 * origin, and the connect screen trades it for a session (`finishOidcSignIn`). A cookie
 * is the whole hand-over, so only the player the server serves signing in to its own
 * server (`onlyOwnServer(servedOrigin(), [server])`) can offer it: never the app, the
 * Metro dev server, or a player hosted on another origin.
 */

/** The served player's return from a single sign-on (`/connect?oidc=1`): its own origin,
 * where the server's cookie is, or null (the app, Metro, another value, or a pairing link,
 * which wins). The route and the connect screen both decide by it. */
export function oidcReturnOrigin(
  oidc: string | string[] | undefined,
  token?: string,
): string | null {
  return !token && firstParam(oidc) === '1' ? servedOrigin() : null;
}

/** The sign-in step's button while the server's `oidc` capability is on: the provider's
 * name ("Sign in with Keycloak"), '' when it sent none (the button then names single
 * sign-on itself), and null while it is off or the server is older. */
export function oidcButtonName(info: ServerInfo | null): string | null {
  if (info?.capabilities?.oidc !== true) return null;
  return info.auth?.oidc?.name?.trim() ?? '';
}

/**
 * A failed finish in words of our own: a 429 names the wait (`sharedRefusalText`); no
 * finished sign-in in this browser (`oidc_no_sign_in`: a reload, or a browser keeping the
 * cookie back); one spent or past its minute (`oidc_sign_in_expired`); no answer from
 * the server; anything else (a 400, a 5xx) as a sign-in that didn't finish. Each says to
 * sign in again: the finish can't be retried (the cookie went with the first try).
 */
export function oidcFinishText(e: unknown, t: TFunction): string {
  if (!(e instanceof ApiError)) return t('connect.oidc.errors.reach');
  if (e.status === 429) return sharedRefusalText(e, t) ?? t('common.tooManyTries');
  switch (apiErrorKind(e)) {
    case 'oidc_no_sign_in':
      return t('connect.oidc.errors.noSignIn');
    case 'oidc_sign_in_expired':
      return t('connect.oidc.errors.expired');
  }
  return t('connect.oidc.errors.failed');
}

/**
 * Finish a single sign-on on the served player's own server (`origin`): `POST
 * /auth/oidc/finish` (the server's cookie goes with it, same origin) with the server's
 * name read alongside, then `finishConnect` as for a pairing link's exchange. Resolves
 * null once the flow has moved on, else why it failed in words (`oidcFinishText`; a
 * session this device then couldn't keep, `notKept`, as the sign-in is spent).
 */
export async function finishOidcSignIn(origin: string, t: TFunction): Promise<string | null> {
  const { client, proxy: carried } = connectClientFor(origin);
  let session: AuthSession;
  let info: ServerInfo | null;
  try {
    [session, info] = await Promise.all([
      client.oidcFinish(getDeviceName()),
      client.serverInfo().catch(() => null),
    ]);
  } catch (e) {
    return oidcFinishText(e, t);
  }
  try {
    await finishConnect({ serverUrl: origin, session, name: info?.name, carried });
    return null;
  } catch {
    return t('connect.oidc.errors.notKept');
  }
}
