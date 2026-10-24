import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import type { Connection } from '@/stores/session';
import { useThemeColors } from '@/theme/use-theme-colors';

import { reconnectConnection } from './reconnect-banner';

export { useSignedOutConnections } from './reconnect-banner';

/** The first of `signedOut` whose list failed among `groups` (one per server): its
 * screen shows the sign-in state for it, not a load error or "no libraries". */
export function refusedConnection(
  signedOut: readonly Connection[],
  groups: readonly { connectionId: string; status: string }[],
): Connection | undefined {
  return signedOut.find((c) => groups.some((g) => g.connectionId === c.id && g.status === 'error'));
}

/**
 * The one state a screen shows for a connection that needs signing in again: "Sign in
 * again to <server>" with the Reconnect action (the banner's own flow,
 * `reconnectConnection`), never a Retry. `compact`: a slim row for a panel (Up next);
 * else a card in the page.
 */
export function SignInAgainState({
  connection,
  compact = false,
  className,
}: {
  connection: Connection;
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const title = t('reconnect.state.title', { name: connection.name });
  const action = t('reconnect.connect.heading');
  const reconnect = () => void reconnectConnection(connection);
  if (compact) {
    return (
      <View
        role="alert"
        className={cn('flex-row items-center gap-2 rounded-xl bg-muted px-3 py-2.5', className)}
      >
        <Icon name="server" size={13} color={themed.brand} />
        <Text variant="caption" className="flex-1">
          {title}
        </Text>
        <Button size="sm" variant="outline" title={action} onPress={reconnect} />
      </View>
    );
  }
  return (
    <EmptyState
      variant="card"
      icon="server"
      title={title}
      hint={t('reconnect.state.hint', { name: connection.name })}
      action={{ label: action, onPress: reconnect }}
      className={className}
    />
  );
}
