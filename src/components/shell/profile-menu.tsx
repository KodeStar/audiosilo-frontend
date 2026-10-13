import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { serverStatus, useReachability } from '@/api/reachability';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { profileName } from '@/components/profiles/profiles-model';
import { Portrait } from '@/components/series/portrait';
import { openProfiles, useChooseProfile } from '@/components/profiles/use-choose-profile';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { onlyOwnServer, servedOrigin } from '@/lib/base-url';
import { openJournal, openSettings } from '@/lib/open';
import { accountHref } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { useActiveProfile, useProfileConnections, useProfiles } from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';
import { useTheme } from '@/theme/theme-provider';
import { useThemeColors } from '@/theme/use-theme-colors';

/**
 * The top bar's profile button and its menu (STYLEGUIDE section 2, the prototype's profile
 * menu; tablet/desktop): who is listening (the active person, ringed) and the other people
 * on this device (choosing one switches, asking for a PIN where they set one), "Who's
 * listening?", then that person's servers with their reachability, each opening its
 * account screen; Add a server; the Journal (the You hub's Journal section); Settings; the
 * account on the default server; and a light/dark appearance switch. Phone keeps these in
 * the Me tab's You hub.
 */
export function ProfileMenu({ showName }: { showName: boolean }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const { scheme, toggleScheme } = useTheme();
  const user = useSession((s) => s.user);
  // The person listening: their servers only (Phase 8).
  const connections = useProfileConnections();
  const defaultId = useSession((s) => s.defaultConnectionId);
  const online = useReachability((s) => s.online);
  const profiles = useProfiles((s) => s.profiles);
  const active = useActiveProfile();
  const { choose, dialog } = useChooseProfile();
  if (!user || !defaultId) return null;

  const name = active ? profileName(active, t) : user.username;
  const others = profiles.filter((p) => p.id !== active?.id);

  const defaultConnection = connections.find((c) => c.id === defaultId);
  const dark = scheme === 'dark';
  const statusLine = (c: Connection) => {
    const status = serverStatus(c, online);
    if (status === 'reconnect') return t('shell.profile.reconnect');
    if (status === 'offline') return t('shell.profile.offline');
    return t('shell.profile.signedInAs', { name: c.user.username });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          testID="top-bar-profile"
          accessibilityLabel={t('shell.profile.label', { name })}
          className={cn(
            'flex-row items-center gap-2 rounded-full border border-border bg-card p-[3px] pr-2 active:bg-accent',
            Platform.select({ web: 'cursor-pointer hover:border-border-strong' }),
          )}
        >
          <Portrait name={name} kind="user" size={30} />
          {showName ? (
            <Text variant="label" numberOfLines={1} className="max-w-[140px]">
              {name}
            </Text>
          ) : null}
          <Icon name="chevron-down" size={14} color={themed.mutedForeground} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[260px]">
          <DropdownMenuLabel>{t('profiles.menu.listeningAs')}</DropdownMenuLabel>
          <DropdownMenuItem
            testID="profile-menu-active"
            onPress={() => undefined}
            accessibilityState={{ selected: true }}
            className="py-1.5"
          >
            <Portrait name={name} kind="user" size={24} ring />
            <Text numberOfLines={1} className="flex-1">
              {name}
            </Text>
            <Icon name="check" size={15} color={themed.mutedForeground} />
          </DropdownMenuItem>
          {others.map((p) => {
            const other = profileName(p, t);
            return (
              <DropdownMenuItem
                key={p.id}
                testID={`profile-menu-${p.id}`}
                onPress={() => void choose(p)}
                accessibilityLabel={t('profiles.menu.switchTo', { name: other })}
                className="py-1.5"
              >
                <Portrait name={other} kind="user" size={24} ring={false} />
                <Text numberOfLines={1} className="flex-1">
                  {other}
                </Text>
                {p.hasPin ? <Icon name="key" size={13} color={themed.mutedForeground} /> : null}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuItem icon="users" onPress={openProfiles}>
            <Text>{t('profiles.picker.title')}</Text>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
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
          {/* The served web player reaches only its own server. */}
          {onlyOwnServer(
            servedOrigin(),
            connections.map((c) => c.serverUrl),
          ) ? null : (
            <DropdownMenuItem icon="plus" onPress={() => router.push('/connect?add=1')}>
              <Text>{t('account.connections.add')}</Text>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem icon="history" onPress={() => openJournal()}>
            <Text>{t('journal.title')}</Text>
          </DropdownMenuItem>
          <DropdownMenuItem icon="settings" onPress={() => openSettings()}>
            <Text>{t('settings.title')}</Text>
          </DropdownMenuItem>
          {defaultConnection ? (
            <DropdownMenuItem icon="user" onPress={() => router.push(accountHref(defaultId))}>
              <Text numberOfLines={1}>
                {t('shell.profile.accountOn', { name: defaultConnection.name })}
              </Text>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem icon={dark ? 'sun' : 'moon'} onPress={toggleScheme}>
            <Text>{dark ? t('shell.profile.light') : t('shell.profile.dark')}</Text>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}
