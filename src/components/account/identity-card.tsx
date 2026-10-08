import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { User } from '@/api/types';
import { Portrait } from '@/components/series/portrait';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';

/**
 * Who is signed in on this server (the prototype's account card): the monogram, the
 * name, "@user · Administrator on Hearthside · signed in on 4 devices" (the count only
 * where the server lists devices) and the role badge.
 */
export function IdentityCard({
  user,
  serverName,
  deviceCount,
  stacked,
}: {
  user: User | null;
  serverName: string;
  /** Signed-in sessions, from `my_devices`; undefined when the server doesn't say. */
  deviceCount: number | undefined;
  /** The device count on its own line (a narrow card). */
  stacked: boolean;
}) {
  const { t } = useTranslation();
  const name = user?.username ?? t('settings.account.signedIn');
  const role =
    user?.role === 'admin' ? t('settings.account.administrator') : t('settings.account.user');
  const who = user
    ? t('account.identity.line', { user: user.username, role, server: serverName })
    : null;
  // One line where it fits; on a narrow card the count gets its own, in sentence case
  // (a wrapped "· signed in on 4 devices" would start a line with the separator).
  const lines =
    deviceCount === undefined
      ? [who]
      : stacked || !who
        ? [who, t('account.identity.devicesLine', { count: deviceCount })]
        : [`${who} · ${t('account.identity.devices', { count: deviceCount })}`];
  return (
    <Card className="flex-row flex-wrap items-center gap-x-4 gap-y-3">
      <Portrait name={name} kind="user" size={64} />
      <View className="min-w-[160px] flex-1 gap-1">
        <Text variant="display" numberOfLines={1} className="text-2xl leading-7">
          {name}
        </Text>
        {lines.map((line) =>
          line ? (
            <Text key={line} variant="muted">
              {line}
            </Text>
          ) : null,
        )}
      </View>
      {user ? (
        <View className="flex-row gap-2">
          {user.is_demo ? (
            <Badge variant="info">
              <Text>{t('account.identity.demo')}</Text>
            </Badge>
          ) : null}
          <Badge variant={user.role === 'admin' ? 'ink' : 'secondary'}>
            <Text>{role}</Text>
          </Badge>
        </View>
      ) : null}
    </Card>
  );
}
