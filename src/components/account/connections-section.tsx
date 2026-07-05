import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useApiRegistry } from '@/api/provider';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { downloadedCountFor, useDownloads } from '@/downloads/store';
import { accountHref } from '@/lib/paths';
import { teardownBeforeTokenRevoke } from '@/playback/store';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';
import { useSession, type Connection } from '@/stores/session';

/** Settings section to manage server connections: open one to manage its account,
 * remove a connection, or add another. Content from every connection appears in the
 * unified Home/Search; tapping a row opens that server's per-connection account
 * screen (`/account?connection=<id>`). */
export function ConnectionsSection() {
  const { t } = useTranslation();
  const { scheme } = useTheme();
  const connections = useSession((s) => s.connections);
  const remove = useSession((s) => s.removeConnection);
  const { clients } = useApiRegistry();
  // Removing a connection purges its downloads (they become unreachable once its id is
  // gone), so a connection with downloaded books gets a confirm step first. The count
  // is snapshotted at tap time (no store subscription: the whole section would
  // otherwise re-render on every download progress tick).
  const [pendingRemoval, setPendingRemoval] = useState<{
    connection: Connection;
    downloadCount: number;
  } | null>(null);

  const performRemove = async (id: string) => {
    const client = clients.get(id);
    // Shared token-revoking teardown (playback stop + queued-progress flush), then
    // best-effort server-side logout, and forget it locally.
    await teardownBeforeTokenRevoke(id);
    void client?.logout().catch(() => {});
    void remove(id);
  };

  const onRemove = (c: Connection) => {
    const count = downloadedCountFor(useDownloads.getState().entries, c.id);
    if (count > 0) setPendingRemoval({ connection: c, downloadCount: count });
    else void performRemove(c.id);
  };

  return (
    <View className="gap-2">
      <Text variant="label">{t('account.connections.label')}</Text>
      <View className="gap-2">
        {connections.map((c) => (
          <View
            key={c.id}
            className="flex-row items-center gap-1 rounded-xl bg-white pr-1 shadow-sm dark:border dark:border-gray-860 dark:bg-gray-840 dark:shadow-none"
          >
            <AnimatedPressable
              onPress={() => router.push(accountHref(c.id))}
              accessibilityRole="button"
              accessibilityLabel={t('account.connections.manage', { name: c.name })}
              className="flex-1 flex-row items-center gap-3 rounded-xl px-3 py-3"
            >
              <Icon name="server" size={18} color={colors[scheme].textMuted} />
              <View className="flex-1">
                <Text variant="subtitle" numberOfLines={1}>
                  {c.name}
                </Text>
                <Text variant="caption" numberOfLines={1}>
                  {c.user.username} · {c.serverUrl}
                </Text>
              </View>
              <Icon name="chevron-right" size={16} color={colors[scheme].textMuted} />
            </AnimatedPressable>
            <AnimatedPressable
              onPress={() => onRemove(c)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('account.connections.remove', { name: c.name })}
              className="h-9 w-9 items-center justify-center rounded-full active:bg-danger/10"
            >
              <Icon name="trash" size={16} color={colors.danger} />
            </AnimatedPressable>
          </View>
        ))}
        <Button
          title={t('account.connections.add')}
          icon="plus"
          variant="secondary"
          onPress={() => router.push('/connect?add=1')}
        />
      </View>

      <ConfirmDialog
        visible={pendingRemoval !== null}
        title={t('account.connections.removeConfirm.title', {
          name: pendingRemoval?.connection.name ?? '',
        })}
        message={t('account.connections.removeConfirm.message', {
          count: pendingRemoval?.downloadCount ?? 0,
        })}
        confirmLabel={t('account.connections.removeConfirm.confirm')}
        confirmIcon="trash"
        onConfirm={() => {
          const c = pendingRemoval?.connection;
          setPendingRemoval(null);
          if (c) void performRemove(c.id);
        }}
        onCancel={() => setPendingRemoval(null)}
      />
    </View>
  );
}
