import { useTranslation } from 'react-i18next';

import { isSignedOutError } from '@/api/client';
import { type RefusedServer, refusedServer, ServerReadError } from '@/api/server-read-error';
import { EmptyState } from '@/components/ui/empty-state';
import { useSession } from '@/stores/session';

import { SignInAgainState } from './sign-in-again';

/** Recovery for a gated read whose /server check was refused. A refused resource keeps
 * its own error handling, and a proxy's refusal leaves its sign-in with AudioSilo alone,
 * unless that sign-in has ended too: then signing in again comes first, as on the shell's
 * banners (`useProxyRefused`). `onReconnect`: see `SignInAgainState` (a dialog closes). */
export function serverRefusalState(
  error: unknown,
  connectionId: string | undefined,
  onReconnect?: () => void,
) {
  const refusal =
    error instanceof ServerReadError && connectionId
      ? refusedServer(connectionId, error.cause)
      : undefined;
  return refusal ? <ServerRefusal {...refusal} onReconnect={onReconnect} /> : null;
}

/** `serverRefusalState` for a dialog's own read, which also takes the server's 401 on that
 * read: a revoked token. `/server` answers anyone, so its check never refuses one, and a
 * Retry could never work; signing in again (with the dialog closed first) can. */
export function readRefusalState(
  error: unknown,
  connectionId: string | undefined,
  onReconnect?: () => void,
) {
  if (connectionId && isSignedOutError(error)) {
    return <ServerRefusal connectionId={connectionId} proxy={false} onReconnect={onReconnect} />;
  }
  return serverRefusalState(error, connectionId, onReconnect);
}

/** One recovery per refused server, on a page that reads every server. */
export function ServerRefusals({ refusals }: { refusals: readonly RefusedServer[] }) {
  return refusals.map((r) => <ServerRefusal key={r.connectionId} {...r} />);
}

export function ServerRefusal({
  connectionId,
  proxy,
  onReconnect,
}: RefusedServer & { onReconnect?: () => void }) {
  const { t } = useTranslation();
  const connection = useSession((s) => s.connections.find((c) => c.id === connectionId));
  if (!connection) return null;
  if (proxy && !connection.needsReconnect) {
    return (
      <EmptyState icon="key" title={t('proxyHeaders.refusedRetry', { name: connection.name })} />
    );
  }
  return <SignInAgainState connection={connection} compact onReconnect={onReconnect} />;
}
