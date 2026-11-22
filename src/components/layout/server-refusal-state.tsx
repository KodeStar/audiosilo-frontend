import { useTranslation } from 'react-i18next';

import { type RefusedServer, serverAccessRefusal } from '@/api/server-read-error';
import { EmptyState } from '@/components/ui/empty-state';
import { useSession } from '@/stores/session';

import { SignInAgainState } from './sign-in-again';

/** Recovery for a gated read whose /server check was refused. A refused resource keeps
 * its own error handling, and a proxy's refusal leaves its sign-in with AudioSilo alone. */
export function serverRefusalState(error: unknown, connectionId: string | undefined) {
  const refusal = serverAccessRefusal(error);
  return refusal && connectionId ? (
    <ServerRefusal connectionId={connectionId} proxy={refusal.fromProxy} />
  ) : null;
}

export function ServerRefusal({ connectionId, proxy }: RefusedServer) {
  const { t } = useTranslation();
  const connection = useSession((s) => s.connections.find((c) => c.id === connectionId));
  if (!connection) return null;
  if (proxy) {
    return (
      <EmptyState icon="key" title={t('proxyHeaders.refusedRetry', { name: connection.name })} />
    );
  }
  return <SignInAgainState connection={connection} compact />;
}
