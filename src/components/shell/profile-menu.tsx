import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { useReachability } from '@/api/reachability';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { accountHref } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { type Connection, useSession } from '@/stores/session';
import { useTheme } from '@/theme/theme-provider';
import { useThemeColors } from '@/theme/use-theme-colors';

export type ServerStatus = 'online' | 'offline' | 'reconnect';

/** What the menu says under a server: it needs signing in again (the reconnect flag
 * wins), it is unreachable, or who you are signed in as. Pure, for the tests. */
export function serverStatus(
  connection: Pick<Connection, 'id' | 'needsReconnect'>,
  online: Record<string, boolean>,
): ServerStatus {
  if (connection.needsReconnect) return 'reconnect';
  return online[connection.id] === false ? 'offline' : 'online';
}

/** The user's initial, in a round monogram (household avatars come in Phase 5). */
function Monogram({ name }: { name: string }) {
  return (
    <View className="h-[30px] w-[30px] items-center justify-center rounded-full bg-secondary">
      <Text className="font-display text-sm text-secondary-foreground">
        {(name.trim()[0] ?? '?').toUpperCase()}
      </Text>
    </View>
  );
}

/**
 * The top bar's profile button and its menu (STYLEGUIDE section 2, the prototype's
 * profile menu without the household, which is Phase 8): every server with its
 * reachability, opening its account screen; Add a server; the account on the default
 * server; and a light/dark appearance switch. Phone keeps these in the Me tab.
 */
export function ProfileMenu({ showName }: { showName: boolean }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const { scheme, setPref } = useTheme();
  const user = useSession((s) => s.user);
  const connections = useSession((s) => s.connections);
  const defaultId = useSession((s) => s.defaultConnectionId);
  const online = useReachability((s) => s.online);
  if (!user || !defaultId) return null;

  const defaultConnection = connections.find((c) => c.id === defaultId);
  const dark = scheme === 'dark';
  const statusLine = (c: Connection) => {
    const status = serverStatus(c, online);
    if (status === 'reconnect') return t('shell.profile.reconnect');
    if (status === 'offline') return t('shell.profile.offline');
    return t('shell.profile.signedInAs', { name: c.user.username });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        testID="top-bar-profile"
        accessibilityLabel={t('shell.profile.label', { name: user.username })}
        className={cn(
          'flex-row items-center gap-2 rounded-full border border-border bg-card p-[3px] pr-2 active:bg-accent',
          Platform.select({ web: 'cursor-pointer hover:border-border-strong' }),
        )}
      >
        <Monogram name={user.username} />
        {showName ? (
          <Text variant="label" numberOfLines={1} className="max-w-[140px]">
            {user.username}
          </Text>
        ) : null}
        <Icon name="chevron-down" size={14} color={themed.mutedForeground} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[260px]">
        <DropdownMenuLabel>{t('shell.profile.servers')}</DropdownMenuLabel>
        {connections.map((c) => (
          <DropdownMenuItem
            key={c.id}
            icon="server"
            onPress={() => router.push(accountHref(c.id))}
            className="py-1.5"
          >
            <View className="flex-1">
              <Text numberOfLines={1}>{c.name}</Text>
              <Text numberOfLines={1} className="text-xs text-muted-foreground">
                {statusLine(c)}
              </Text>
            </View>
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem icon="plus" onPress={() => router.push('/connect?add=1')}>
          <Text>{t('account.connections.add')}</Text>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {defaultConnection ? (
          <DropdownMenuItem icon="user" onPress={() => router.push(accountHref(defaultId))}>
            <Text numberOfLines={1}>
              {t('shell.profile.accountOn', { name: defaultConnection.name })}
            </Text>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem icon="settings" onPress={() => setPref(dark ? 'light' : 'dark')}>
          <Text>{dark ? t('shell.profile.light') : t('shell.profile.dark')}</Text>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
