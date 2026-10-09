import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ApiError } from '@/api/client';
import { CapabilityError, useCapability, useHousehold, useSetHousehold } from '@/api/hooks';
import { SettingRow } from '@/components/settings/settings-row';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useSession } from '@/stores/session';

/**
 * "Share what I'm listening to with the house" for ONE connection (Settings > Household;
 * the pane renders one per connection of the active profile, inside its `SettingsCard`).
 * Hidden when the server lacks `household` (or while that is not known yet, or the
 * connection is gone). The switch moves at once (optimistic) and settles on the server's
 * answer; a refusal puts it back and says so in a toast (a demo account gets its own
 * words). While the setting loads, or a change is in flight, the switch waits disabled;
 * a load that failed offers Retry.
 */
export function HouseSharingRow({
  connectionId,
  first,
}: {
  connectionId: string;
  first?: boolean;
}) {
  const { t } = useTranslation();
  const supported = useCapability('household', connectionId);
  const server = useSession((s) => s.connections.find((c) => c.id === connectionId)?.name);
  const settings = useHousehold(connectionId);
  const set = useSetHousehold(connectionId);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  if (supported !== true || server === undefined) return null;

  const loaded = settings.data !== undefined;
  const value = optimistic ?? settings.data?.share_listening ?? false;
  const pending = optimistic !== null;

  const change = async (share: boolean) => {
    setOptimistic(share);
    try {
      // Stores the server's answer in the cache before it resolves, so dropping the
      // optimistic value below never flickers.
      await set.mutateAsync(share);
    } catch (e) {
      // Never sent (the server lost the flag meanwhile): the row hides itself.
      if (e instanceof CapabilityError) return;
      toast(
        e instanceof ApiError && e.status === 403
          ? { title: t('house.share.demo') }
          : {
              title: t('house.share.failed', { server }),
              description: t('house.share.failedBody'),
            },
      );
    } finally {
      setOptimistic(null);
    }
  };

  const status =
    settings.isError && !loaded ? (
      <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1.5 pt-1">
        <Text variant="caption" className="text-destructive">
          {t('house.share.loadFailed')}
        </Text>
        <Button
          title={t('common.retry')}
          icon="rotate"
          variant="outline"
          size="sm"
          onPress={() => void settings.refetch()}
        />
      </View>
    ) : pending ? (
      <Text variant="caption" accessibilityLiveRegion="polite">
        {t('house.share.saving')}
      </Text>
    ) : null;

  return (
    <SettingRow
      testID={`house-sharing-${connectionId}`}
      first={first}
      label={t('house.share.label')}
      description={
        <>
          <Text variant="caption">{t('house.share.body', { server })}</Text>
          {status}
        </>
      }
    >
      <Switch
        checked={value}
        onCheckedChange={(share) => void change(share)}
        disabled={!loaded || pending}
        accessibilityLabel={t('house.share.switchLabel', { server })}
      />
    </SettingRow>
  );
}
