import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { useApiRegistry } from '@/api/provider';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useSession } from '@/stores/session';
import { colors } from '@/theme/tokens';

/** Settings section to manage server connections: switch the active one, remove a
 * connection, or add another. Content from non-active connections still appears in
 * the unified Home/Search; the active connection is the default for new playback. */
export function ConnectionsSection() {
  const { t } = useTranslation();
  const connections = useSession((s) => s.connections);
  const activeId = useSession((s) => s.activeConnectionId);
  const setActive = useSession((s) => s.setActiveConnection);
  const remove = useSession((s) => s.removeConnection);
  const { clients } = useApiRegistry();

  const onRemove = (id: string) => {
    // Best-effort server-side logout for that connection, then forget it locally.
    void clients
      .get(id)
      ?.logout()
      .catch(() => {});
    void remove(id);
  };

  return (
    <View className="gap-2">
      <Text variant="label">{t('account.connections.label')}</Text>
      <Card className="gap-1">
        {connections.map((c) => {
          const active = c.id === activeId;
          return (
            <View key={c.id} className="flex-row items-center gap-1">
              <Pressable
                onPress={() => setActive(c.id)}
                accessibilityRole="button"
                className={`flex-1 flex-row items-center gap-3 rounded-md px-3 py-2 ${
                  active ? 'bg-primary/10 dark:bg-primary/20' : 'active:opacity-70'
                }`}
              >
                <Icon name="server" size={16} color={active ? colors.primary : undefined} />
                <View className="flex-1">
                  <Text variant="subtitle" numberOfLines={1}>
                    {c.name}
                  </Text>
                  <Text variant="caption" numberOfLines={1}>
                    {c.user.username} · {c.serverUrl}
                  </Text>
                </View>
                {active ? <Icon name="check" size={16} color={colors.primary} /> : null}
              </Pressable>
              <Pressable
                onPress={() => onRemove(c.id)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('account.connections.remove', { name: c.name })}
                className="px-3 py-2 active:opacity-60"
              >
                <Icon name="trash" size={16} />
              </Pressable>
            </View>
          );
        })}
        <Button
          title={t('account.connections.add')}
          icon="plus"
          variant="secondary"
          onPress={() => router.push('/connect?add=1')}
        />
      </Card>
    </View>
  );
}
