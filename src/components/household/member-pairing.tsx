import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useMemberPairing } from '@/api/hooks';
import type { HouseholdMember } from '@/api/types';
import { PairingCode } from '@/components/account/pair-device-card';
import { usePairingCode } from '@/components/account/use-pairing';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form-error';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * A household member's own pairing code (Phase 8b-1: "Show Ellis this code", "Set up their
 * own device"): asked for as soon as it shows (`POST /me/household/members/{id}/pair`,
 * single-use for 10 minutes), then the same QR, countdown, copy or share and "Make a new
 * code" as "Pair another device" (`PairingCode`). The member scans it with the app on
 * their own device, which signs in as them. Done is the dialog's (its footer): the code
 * has none of its own here.
 */
export function MemberPairing({
  connectionId,
  serverName,
  member,
}: {
  connectionId: string;
  serverName: string;
  member: Pick<HouseholdMember, 'id' | 'name'>;
}) {
  const { t } = useTranslation();
  const mint = useMemberPairing(connectionId);
  const pairing = usePairingCode(
    () => mint.mutateAsync(member.id),
    t('household.qr.failed', { server: serverName }),
  );
  // Asked for once, when it shows.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void pairing.create();
  }, [pairing]);

  return (
    <View className="gap-3" testID="member-pairing">
      {pairing.payload ? (
        <PairingCode
          pairing={pairing}
          qrLabel={t('household.qr.a11y', { name: member.name, server: serverName })}
          body={t('household.qr.body', { name: member.name })}
          hideDone
        />
      ) : pairing.error ? (
        <Button
          variant="outline"
          icon="rotate"
          className="self-start"
          title={t('common.retry')}
          loading={pairing.loading}
          onPress={() => void pairing.create()}
        />
      ) : (
        <View className="flex-row items-center gap-4" testID="member-pairing-loading">
          <Skeleton className="h-[156px] w-[156px] rounded-xl" />
          <View className="flex-1 gap-2">
            <Skeleton className="h-3.5 w-2/3 rounded-sm" />
            <Skeleton className="h-3 w-1/2 rounded-sm" />
          </View>
        </View>
      )}
      <FormError error={pairing.error} />
    </View>
  );
}
