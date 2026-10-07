import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { User } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';

import { Avatar } from './avatar';

/**
 * Who is signed in on this server (the prototype's account card): the monogram, the
 * name, "@user · Administrator on Hearthside · signed in on 4 devices" (the count only
 * where the server lists devices) and the role badge.
 */
export function IdentityCard({
  user,
  serverName,
  deviceCount,
}: {
  user: User | null;
  serverName: string;
  /** Signed-in sessions, from `my_devices`; undefined when the server doesn't say. */
  deviceCount: number | undefined;
}) {
  const { t } = useTranslation();
  const name = user?.username ?? t('settings.account.signedIn');
  const role =
    user?.role === 'admin' ? t('settings.account.administrator') : t('settings.account.user');
  const line = [
    user ? t('account.identity.line', { user: user.username, role, server: serverName }) : null,
    deviceCount !== undefined ? t('account.identity.devices', { count: deviceCount }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Card className="flex-row flex-wrap items-center gap-x-4 gap-y-3">
      <Avatar name={name} size={64} />
      <View className="min-w-[160px] flex-1 gap-1">
        <Text variant="display" numberOfLines={1} className="text-2xl leading-7">
          {name}
        </Text>
        {line ? <Text variant="muted">{line}</Text> : null}
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
