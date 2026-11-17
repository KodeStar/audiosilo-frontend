import type { TFunction } from 'i18next';

import type { Connection } from '@/stores/session';

/** The sign-in state's words for `connection`, by why it needs signing in again, as the
 * reconnect banner's (fe#147): a server that was reset says so, and that this device pairs
 * with it again. */
export function signInAgainCopy(
  connection: Connection,
  t: TFunction,
): { title: string; hint: string } {
  const name = connection.name;
  return connection.needsReconnect === 'server-reset'
    ? {
        title: t('reconnect.state.titleReset', { name }),
        hint: t('reconnect.state.hintReset', { name }),
      }
    : { title: t('reconnect.state.title', { name }), hint: t('reconnect.state.hint', { name }) };
}
