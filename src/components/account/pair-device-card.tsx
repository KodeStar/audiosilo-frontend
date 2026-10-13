import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, Platform, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { copyText } from '@/lib/clipboard';
import { shareText } from '@/lib/share';
import { formatClock } from '@/lib/format';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';

import { type PairingCodeState, usePairing } from './use-pairing';

/** The drawn QR code's side, in points. */
const QR_SIZE = 140;

/**
 * "Pair another device" (the prototype's pairing card): a button makes a pairing code,
 * then the code (`PairingCode`) until it is done.
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

  return (
    <Card className={cn('gap-3', className)}>
      <Text variant="title" accessibilityRole="header">
        {t('account.pair.title')}
      </Text>
      {pairing.payload ? (
        <PairingCode
          pairing={pairing}
          qrLabel={t('account.pair.qr', { server: serverName })}
          body={t('account.pair.body')}
        />
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
      <PairingError error={pairing.error} />
    </Card>
  );
}

/** Why a code could not be made (the server's words, or what to try). */
export function PairingError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <Text className="text-sm text-destructive" accessibilityLiveRegion="polite">
      {error}
    </Text>
  );
}

/**
 * A pairing code on screen: the server's QR image with a live countdown ("Expires in
 * 9:42"), the link to copy (web) or share (iOS and Android: the share sheet, whose first
 * action is Copy), "Make a new code" once it has expired, and Done (`onDone`, else the
 * code is put away; `hideDone`: the dialog it sits in has Done in its footer). The link
 * shows on one line, cut short with an ellipsis (Copy link copies all of it). Used by
 * "Pair another device" and a household member's own device ("Show Ellis this code").
 */
export function PairingCode({
  pairing,
  qrLabel,
  body,
  onDone,
  doneLabel,
  hideDone = false,
}: {
  pairing: PairingCodeState;
  /** The QR image's screen-reader label. */
  qrLabel: string;
  /** What to do with it, beside the code while it is live. */
  body: string;
  onDone?: () => void;
  doneLabel?: string;
  hideDone?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const payload = pairing.payload;
  if (!payload) return null;

  const copy = async () => {
    if (await copyText(payload.web_url)) setCopied(true);
  };
  const renew = () => {
    setCopied(false);
    void pairing.create();
  };

  return (
    <View className="flex-row flex-wrap items-center gap-4">
      <View
        className={cn('rounded-xl bg-white p-2', pairing.expired && 'opacity-25')}
        accessible
        accessibilityRole="image"
        accessibilityLabel={qrLabel}
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
            <Text variant="muted">{body}</Text>
            <Text variant="label" style={tabularNums} testID="pair-countdown">
              {t('account.pair.expiresIn', { time: formatClock(pairing.secondsLeft) })}
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
              icon={copied ? 'check' : 'copy'}
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
          {hideDone ? null : (
            <Button
              variant="ghost"
              title={doneLabel ?? t('settings.devices.done')}
              onPress={() => {
                setCopied(false);
                if (onDone) onDone();
                else pairing.dismiss();
              }}
            />
          )}
        </View>
        {!pairing.expired && Platform.OS === 'web' ? (
          <Text
            selectable
            variant="caption"
            numberOfLines={1}
            ellipsizeMode="tail"
            testID="pair-link"
          >
            {payload.web_url}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
