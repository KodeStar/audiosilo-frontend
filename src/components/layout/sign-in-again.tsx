import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useProfileConnections } from '@/stores/profiles';
import type { Connection } from '@/stores/session';
import { useThemeColors } from '@/theme/use-theme-colors';

import { reconnectConnection } from './reconnect-banner';

/**
 * The person listening's connections whose sign-in ended (`needsReconnect`: a 401 on any
 * request, or a server reset), in connection order. A screen whose load failed for one of
 * them shows `SignInAgainState` in place of its load error and its empty state
 * (frontend#124): asking again cannot help, signing in again does.
 */
export function useSignedOutConnections(): Connection[] {
  return useProfileConnections().filter((c) => c.needsReconnect);
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
