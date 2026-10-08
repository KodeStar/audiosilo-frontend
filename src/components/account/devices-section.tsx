import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ApiError } from '@/api/client';
import { CapabilityError, useMyDevices, useRevokeMyDevice } from '@/api/hooks';
import type { MyDevice } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { touchTarget } from '@/components/ui/touch-target';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { canRevoke, deviceGlyph, knownPlatform, lastSeen, signedInSessions } from './account-model';
import { AccountSectionHead } from './section-head';

/** A small button's drawn height in rem (`h-[30px]` on the web's 16 px rem), for its
 * 44 pt frame on native. */
const SM_BUTTON_REM = 30 / 16;

/** The name a device row shows: the one it sent at sign-in, else "Unnamed device". */
function deviceName(d: MyDevice, t: TFunction): string {
  return d.name.trim() || t('account.devices.unnamed');
}

/** "AudioSilo 1.4.2 · iOS · last seen 2 hours ago". */
function deviceDetail(d: MyDevice, t: TFunction, now: number): string {
  const parts: string[] = [];
  if (d.client) {
    parts.push(`${d.client.app} ${d.client.version}`.trim());
    const p = knownPlatform(d.client.platform);
    if (p) parts.push(t(`account.devices.platform.${p}`));
    else if (d.client.platform) parts.push(d.client.platform);
  } else {
    parts.push(t('account.devices.unknownApp'));
  }
  const seen = lastSeen(d, now);
  parts.push(
    seen.kind === 'now'
      ? t('account.devices.activeNow')
      : seen.kind === 'never'
        ? t('account.devices.never')
        : t(`account.devices.seen.${seen.unit}`, { count: seen.count }),
  );
  return parts.join(' · ');
}

/**
 * "Signed-in devices" (capability `my_devices`; the page renders it only when the
 * server has it): the account's sessions, this device first and marked, each with its
 * app, platform and when it was last seen. Another device signs out after a
 * confirmation (`useRevokeMyDevice`) and a toast says so, or what went wrong and that
 * nothing changed.
 *
 * The device the listener is on offers NOTHING here: revoking its own token through
 * `useRevokeMyDevice` would kill it before the sign-out teardown (save the final
 * position, flush the queued progress) runs. It signs out from the page's "Sign out of
 * <server>", which goes through `useSignOut`.
 */
export function DevicesSection({
  connectionId,
  serverName,
}: {
  connectionId: string;
  serverName: string;
}) {
  const { t } = useTranslation();
  const devices = useMyDevices(connectionId);
  const revoke = useRevokeMyDevice(connectionId);
  const [pending, setPending] = useState<MyDevice | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const rows = signedInSessions(devices.data);
  // "last seen 5 minutes ago" moves by the minute.
  const now = useNow(60_000);

  const confirm = async () => {
    const device = pending;
    setPending(null);
    // Never this device (see above); its row has no sign-out to reach here, and this
    // guard keeps it that way.
    if (!device || !canRevoke(device)) return;
    const name = deviceName(device, t);
    setBusyId(device.id);
    try {
      await revoke.mutateAsync(device.id);
      toast({
        title: t('account.devices.done', { name }),
        description: t('account.devices.doneBody', { server: serverName }),
      });
    } catch (e) {
      // Never sent (the server lost the flag meanwhile): nothing to report.
      if (e instanceof CapabilityError) return;
      if (e instanceof ApiError && e.status === 404) {
        // Signed out elsewhere already: say so and bring the list up to date.
        toast({
          title: t('account.devices.gone', { name }),
          description: t('account.devices.goneBody'),
        });
        void devices.refetch();
        return;
      }
      toast({
        title: t('account.devices.failed', { name }),
        description: t('account.devices.failedBody', { server: serverName }),
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <View className="gap-3">
      <AccountSectionHead title={t('account.devices.title')} sub={t('account.devices.sub')} />
      <Card className="overflow-hidden p-0">
        {devices.isError ? (
          <View className="gap-3 p-5">
            <Text variant="muted">{t('account.devices.loadError', { server: serverName })}</Text>
            <Button
              variant="outline"
              className="self-start"
              title={t('common.retry')}
              onPress={() => void devices.refetch()}
            />
          </View>
        ) : devices.isPending ? (
          <DevicesSkeleton />
        ) : (
          rows.map((d, i) => (
            <DeviceRow
              key={d.id}
              device={d}
              first={i === 0}
              detail={deviceDetail(d, t, now)}
              name={deviceName(d, t)}
              busy={busyId === d.id}
              onSignOut={() => setPending(d)}
            />
          ))
        )}
      </Card>
      {devices.isSuccess && rows.length <= 1 ? (
        <Text variant="caption">{t('account.devices.onlyThis')}</Text>
      ) : null}
      <ConfirmDialog
        visible={pending !== null}
        title={t('account.devices.confirm.title', {
          name: pending ? deviceName(pending, t) : '',
        })}
        message={t('account.devices.confirm.message', {
          name: pending ? deviceName(pending, t) : '',
          server: serverName,
        })}
        confirmLabel={t('account.devices.confirm.confirm')}
        confirmIcon="logout"
        destructive
        onConfirm={() => void confirm()}
        onCancel={() => setPending(null)}
      />
    </View>
  );
}

function DeviceRow({
  device,
  name,
  detail,
  first,
  busy,
  onSignOut,
}: {
  device: MyDevice;
  name: string;
  detail: string;
  first: boolean;
  busy: boolean;
  onSignOut: () => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const target = touchTarget(SM_BUTTON_REM);
  return (
    <View
      testID={`device-${device.id}`}
      className={cn('flex-row items-center gap-3 px-4 py-3', !first && 'border-t border-border')}
    >
      <View className="h-9 w-9 items-center justify-center rounded-[11px] bg-muted">
        <Icon name={deviceGlyph(device)} size={17} color={themed.mutedForeground} />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
          <Text variant="label" numberOfLines={1} className="shrink">
            {name}
          </Text>
          {device.current ? (
            <Badge variant="success">
              <Text>{t('account.devices.thisDevice')}</Text>
            </Badge>
          ) : null}
        </View>
        <Text variant="caption" numberOfLines={2}>
          {detail}
        </Text>
      </View>
      {canRevoke(device) ? (
        <Button
          size="sm"
          variant="ghost"
          title={t('account.devices.signOut')}
          accessibilityLabel={t('account.devices.signOutLabel', { name })}
          loading={busy}
          hitSlop={target.hitSlop}
          className={target.frameClass}
          onPress={onSignOut}
        />
      ) : null}
    </View>
  );
}

function DevicesSkeleton() {
  return (
    <View testID="devices-loading">
      {[0, 1, 2].map((i) => (
        <View
          key={i}
          className={cn('flex-row items-center gap-3 px-4 py-3', i > 0 && 'border-t border-border')}
        >
          <Skeleton className="h-9 w-9 rounded-[11px]" />
          <View className="flex-1 gap-2">
            <Skeleton className="h-3.5 w-1/3 rounded-sm" />
            <Skeleton className="h-3 w-2/3 rounded-sm" />
          </View>
        </View>
      ))}
    </View>
  );
}
