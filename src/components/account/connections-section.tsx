import { router } from 'expo-router';
import type { TFunction } from 'i18next';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useApiRegistry } from '@/api/provider';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Icon } from '@/components/ui/icon';
import { RowSurface } from '@/components/ui/row-surface';
import { Text } from '@/components/ui/text';
import { touchTarget } from '@/components/ui/touch-target';
import { downloadedCountFor, useDownloads } from '@/downloads/store';
import { onlyOwnServer, servedOrigin } from '@/lib/base-url';
import { accountHref } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { unsentListens } from '@/playback/listening-outbox';
import { teardownBeforeTokenRevoke } from '@/playback/store';
import { useThemeColors } from '@/theme/use-theme-colors';
import { useProfileConnections } from '@/stores/profiles';
import { useSession, type Connection } from '@/stores/session';

/** The drawn remove button's size in rem (`h-9 w-9`). */
const REMOVE_REM = 2.25;

/**
 * The remove-connection flow, split into a hook so the owning screen holds the confirm
 * dialog's state: the screen calls this hook, threads `onRemove` into the section, and
 * renders `dialog` (a portaled `ConfirmDialog`, so where it sits in the tree doesn't
 * matter).
 *
 * Every removal is confirmed first (frontend#143: one tap signed the device out, even of
 * its last server), saying what is lost: the downloads (unreachable once its id is gone,
 * so they are purged), else the sign-in on this device; and for the last server, that the
 * app goes back to its first step. The download count is snapshotted at tap time (no
 * store subscription: the whole section would otherwise re-render on every download
 * progress tick).
 */
export function useConnectionRemoval(): { onRemove: (c: Connection) => void; dialog: ReactNode } {
  const { t } = useTranslation();
  const remove = useSession((s) => s.removeConnection);
  const { clients } = useApiRegistry();
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);

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
    const last = useSession.getState().connections.every((o) => o.id === c.id);
    // Sync v2's listens get a last send first; any left are named in the confirm.
    void unsentListens(c.id)
      .catch(() => 0)
      .then((unsynced) =>
        setPendingRemoval({ connection: c, downloadCount: count, last, unsynced }),
      );
  };

  const dialog = (
    <ConfirmDialog
      visible={pendingRemoval !== null}
      title={t('account.connections.removeConfirm.title', {
        name: pendingRemoval?.connection.name ?? '',
      })}
      message={removeMessage(pendingRemoval, t)}
      confirmLabel={t('account.connections.removeConfirm.confirm')}
      confirmIcon="trash"
      destructive
      onConfirm={() => {
        const c = pendingRemoval?.connection;
        setPendingRemoval(null);
        if (c) void performRemove(c.id);
      }}
      onCancel={() => setPendingRemoval(null)}
    />
  );

  return { onRemove, dialog };
}

type PendingRemoval = {
  connection: Connection;
  downloadCount: number;
  last: boolean;
  /** Sync v2 listens still not on the server (lost with it). */
  unsynced: number;
};

/** What removing a server loses, in words: its downloads, else this device's sign-in;
 * the listens that haven't synced; and the way back to the first step when it is the last
 * server. */
function removeMessage(pending: PendingRemoval | null, t: TFunction): string {
  if (!pending) return '';
  const parts = [
    pending.downloadCount > 0
      ? t('account.connections.removeConfirm.message', { count: pending.downloadCount })
      : t('account.connections.removeConfirm.signOut', { name: pending.connection.name }),
  ];
  if (pending.unsynced > 0) {
    parts.push(
      t('account.connections.removeConfirm.unsynced', {
        count: pending.unsynced,
        name: pending.connection.name,
      }),
    );
  }
  if (pending.last) parts.push(t('account.connections.removeConfirm.last'));
  return parts.join(' ');
}

/** Settings' "Accounts and devices" pane: the signed-in servers, each opening its own
 * account (`/account?connection=<id>`: password, devices, API keys, sign out), a remove
 * action per server, and Add a server. Content from every connection appears in the
 * unified Home/Search. The remove flow's confirm dialog is owned by
 * `useConnectionRemoval` and rendered by the screen; this section just invokes
 * `onRemove`. The pane's heading is the caller's. */
export function ConnectionsSection({ onRemove }: { onRemove: (c: Connection) => void }) {
  const themed = useThemeColors();
  const { t } = useTranslation();
  // The person listening's servers (Phase 8 profiles): Settings > Servers is theirs.
  const connections = useProfileConnections();
  const { frameClass, hitSlop } = touchTarget(REMOVE_REM, REMOVE_REM);

  return (
    <View className="gap-2">
      <View className="gap-2">
        {connections.map((c) => (
          <RowSurface key={c.id} className="flex-row items-center gap-1 pr-1">
            <AnimatedPressable
              onPress={() => router.push(accountHref(c.id))}
              accessibilityRole="button"
              accessibilityLabel={t('account.connections.manage', { name: c.name })}
              className="flex-1 flex-row items-center gap-3 rounded-xl px-3 py-3"
            >
              <Icon name="server" size={18} color={themed.mutedForeground} />
              <View className="flex-1">
                <Text variant="label" numberOfLines={1}>
                  {c.name}
                </Text>
                <Text variant="caption" numberOfLines={1}>
                  {c.user.username} · {c.serverUrl}
                </Text>
              </View>
              <Icon name="chevron-right" size={16} color={themed.mutedForeground} />
            </AnimatedPressable>
            <AnimatedPressable
              onPress={() => onRemove(c)}
              hitSlop={hitSlop}
              accessibilityRole="button"
              accessibilityLabel={t('account.connections.remove', { name: c.name })}
              className={cn('items-center justify-center', frameClass)}
            >
              <View className="h-9 w-9 items-center justify-center rounded-full active:bg-destructive/10">
                <Icon name="trash" size={16} color={themed.destructive} />
              </View>
            </AnimatedPressable>
          </RowSurface>
        ))}
        {/* The served web player reaches only its own server. */}
        {onlyOwnServer(
          servedOrigin(),
          connections.map((c) => c.serverUrl),
        ) ? null : (
          <Button
            title={t('account.connections.add')}
            icon="plus"
            variant="secondary"
            onPress={() => router.push('/connect?add=1')}
            className="self-start"
          />
        )}
      </View>
    </View>
  );
}
