import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ADDRESS_IN_USE_LABEL, ADDRESS_KIND_LABEL } from '@/api/address-route';
import type { ServerAddresses } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Icon, type IconName } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { AddressKind } from '@/lib/server-address';
import { useThemeColors } from '@/theme/use-theme-colors';

/**
 * "At home and away" (capability `addresses`): a server's home-network address and the
 * one that works from anywhere, each in mono, under `body`. Connect shows it when the
 * server has both; Account shows whichever it knows, and on native which one this device
 * is using now (`inUse`, from `useActiveAddress`): that line gets an "In use" badge and
 * the card says so in words. Web never switches (the served player stays on the address
 * it was opened at), so it passes no `inUse`. Renders nothing when neither is known.
 */
export function AddressesCard({
  addresses,
  body,
  inUse,
}: {
  addresses: ServerAddresses;
  body: string;
  inUse?: AddressKind;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  if (!addresses.home && !addresses.away) return null;
  return (
    <Card testID="addresses-card" className="w-full gap-3 p-4">
      <View className="gap-1">
        <Text variant="title" accessibilityRole="header">
          {t('addresses.title')}
        </Text>
        <Text variant="muted">{body}</Text>
      </View>
      {addresses.home ? (
        <AddressLine kind="home" icon="home" url={addresses.home} inUse={inUse === 'home'} />
      ) : null}
      {addresses.away ? (
        <AddressLine kind="away" icon="globe" url={addresses.away} inUse={inUse === 'away'} />
      ) : null}
      {inUse ? (
        <View className="flex-row items-start gap-2" testID="address-in-use">
          <Icon name="circle-check" size={14} color={themed.success} />
          <Text variant="caption" className="min-w-0 flex-1">
            {t(ADDRESS_IN_USE_LABEL[inUse])}
            {inUse === 'paired' ? '' : ` ${t('addresses.switches')}`}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

function AddressLine({
  kind,
  icon,
  url,
  inUse,
}: {
  kind: 'home' | 'away';
  icon: IconName;
  url: string;
  inUse: boolean;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const label = t(ADDRESS_KIND_LABEL[kind]);
  return (
    <View
      accessible
      accessibilityLabel={inUse ? `${label}: ${url}, ${t('addresses.inUse')}` : `${label}: ${url}`}
      className="flex-row items-center gap-3"
    >
      <View className="h-9 w-9 items-center justify-center rounded-[11px] bg-muted">
        <Icon name={icon} size={16} color={themed.mutedForeground} />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row flex-wrap items-center gap-2">
          <Text variant="caption">{label}</Text>
          {inUse ? (
            <Badge variant="success">
              <Text>{t('addresses.inUse')}</Text>
            </Badge>
          ) : null}
        </View>
        <Text variant="mono" selectable numberOfLines={2}>
          {url}
        </Text>
      </View>
    </View>
  );
}
