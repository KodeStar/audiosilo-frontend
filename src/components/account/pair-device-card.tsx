import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, Platform, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { copyText } from '@/lib/clipboard';
import { shareText } from '@/lib/share';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';

import { formatCountdown } from './account-model';
import { usePairing } from './use-pairing';

/** The drawn QR code's side, in points. */
const QR_SIZE = 140;

/**
 * "Pair another device" (the prototype's pairing card): a button makes a pairing code,
 * then the server's QR image with a live countdown ("Expires in 9:42"), the link to copy
 * (web) or share (iOS and Android: the share sheet, whose first action is Copy), and
 * "Make a new code" once it has expired.
 */
export function PairDeviceCard({
  connectionId,
  serverName,
  className,
}: {
  connectionId: string;
  serverName: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const pairing = usePairing(connectionId, serverName);
  const [copied, setCopied] = useState(false);
  const payload = pairing.payload;

  const copy = async () => {
    if (!payload) return;
    if (await copyText(payload.web_url)) setCopied(true);
  };
  const renew = () => {
    setCopied(false);
    void pairing.create();
  };

  return (
    <Card className={cn('gap-3', className)}>
      <Text variant="title" accessibilityRole="header">
        {t('account.pair.title')}
      </Text>
      {payload ? (
        <View className="flex-row flex-wrap items-center gap-4">
          <View
            className={cn('rounded-xl bg-white p-2', pairing.expired && 'opacity-25')}
            accessible
            accessibilityRole="image"
            accessibilityLabel={t('account.pair.qr', { server: serverName })}
          >
            <Image
              source={{ uri: payload.qr_png_data_uri }}
              style={{ width: QR_SIZE, height: QR_SIZE }}
            />
          </View>
          <View className="min-w-[160px] flex-1 gap-2">
            {pairing.expired ? (
              <Text variant="muted">{t('account.pair.expired')}</Text>
            ) : (
              <>
                <Text variant="muted">{t('account.pair.body')}</Text>
                <Text variant="label" style={tabularNums} testID="pair-countdown">
                  {t('account.pair.expiresIn', { time: formatCountdown(pairing.secondsLeft) })}
                </Text>
              </>
            )}
            <View className="flex-row flex-wrap gap-2">
              {pairing.expired ? (
                <Button
                  variant="outline"
                  icon="rotate"
                  title={t('account.pair.renew')}
                  loading={pairing.loading}
                  onPress={renew}
                />
              ) : Platform.OS === 'web' ? (
                <Button
                  variant="outline"
                  icon={copied ? 'check' : undefined}
                  title={copied ? t('common.copied') : t('account.pair.copy')}
                  onPress={() => void copy()}
                />
              ) : (
                <Button
                  variant="outline"
                  icon="share"
                  title={t('settings.devices.share')}
                  onPress={() => void shareText(payload.web_url)}
                />
              )}
              <Button
                variant="ghost"
                title={t('settings.devices.done')}
                onPress={() => {
                  setCopied(false);
                  pairing.dismiss();
                }}
              />
            </View>
            {!pairing.expired && Platform.OS === 'web' ? (
              <Text selectable variant="caption" numberOfLines={2}>
                {payload.web_url}
              </Text>
            ) : null}
          </View>
        </View>
      ) : (
        <>
          <Text variant="muted">{t('account.pair.body')}</Text>
          <Button
            variant="outline"
            icon="qrcode"
            className="self-start"
            title={t('account.pair.show')}
            loading={pairing.loading}
            onPress={() => void pairing.create()}
          />
        </>
      )}
      {pairing.error ? (
        <Text className="text-sm text-destructive" accessibilityLiveRegion="polite">
          {pairing.error}
        </Text>
      ) : null}
    </Card>
  );
}
