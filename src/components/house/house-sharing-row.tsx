import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { apiErrorKind } from '@/api/client';
import { CapabilityError, useHousehold, useSetHousehold } from '@/api/hooks';
import { SettingRow } from '@/components/settings/settings-row';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { isKidAccount } from '@/lib/account';
import { useConnectionName, useSession } from '@/stores/session';

/**
 * "Share what I'm listening to with the house" for ONE connection (the Household page's
 * "Listening in the house" renders one per connection of the active profile whose server
 * has `household`, inside its `SettingsCard`). Hidden when the connection is gone. The
 * switch moves at once (optimistic) and settles on the server's answer; a refusal puts it
 * back and says so in a toast (a demo account and a kid's account get their own words).
 * A kid's account (8b-1) can't share at all (the server refuses it): its row says so,
 * switched off. While the setting loads, or a change is in flight, the switch waits
 * disabled; a load that failed offers Retry.
 */
export function HouseSharingRow({
  connectionId,
  first,
}: {
  connectionId: string;
  first?: boolean;
}) {
  const { t } = useTranslation();
  const server = useConnectionName(connectionId);
  const settings = useHousehold(connectionId);
  const set = useSetHousehold(connectionId);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const kid = useSession((s) =>
    isKidAccount(s.connections.find((c) => c.id === connectionId)?.user),
  );
  if (!server) return null;

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
      // Never sent (the server lost the flag meanwhile): the pane drops the row.
      if (e instanceof CapabilityError) return;
      const kind = apiErrorKind(e);
      toast(
        kind === 'kid_account'
          ? { title: t('house.share.kid') }
          : kind === 'demo_account' || kind === 'forbidden'
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
          <Text variant="caption">
            {kid ? t('house.share.kid') : t('house.share.body', { server })}
          </Text>
          {kid ? null : status}
        </>
      }
    >
      <Switch
        checked={kid ? false : value}
        onCheckedChange={(share) => void change(share)}
        disabled={kid || !loaded || pending}
        accessibilityLabel={t('house.share.switchLabel', { server })}
      />
    </SettingRow>
  );
}
