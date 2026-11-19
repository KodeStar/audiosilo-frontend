import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/support';

/**
 * Where to get the AudioSilo app: the same three links as the server's own connect page
 * (audiosilo-server `internal/web/assets/index.html`) and its pairing payload's `links`
 * (`PairingPayload.links`, `qr.go`): the App Store, Google Play, and the APK on the player's
 * GitHub releases for an Android phone without Play. Keep the three in step with the server.
 */
export const APP_LINKS = {
  ios: 'https://apps.apple.com/us/app/audiosilo/id6783431375',
  android: 'https://play.google.com/store/apps/details?id=app.audiosilo',
  apk: 'https://github.com/KodeStar/audiosilo-frontend/releases/latest',
} as const;

/** The web connect screen's "Get the AudioSilo app" (fe#299): the browser is where someone
 * without the app starts, as on the server's own connect page. */
export function GetAppLinks() {
  const { t } = useTranslation();
  return (
    <View className="gap-2" testID="connect-get-app">
      <Text variant="eyebrow">{t('connect.getApp.title')}</Text>
      <View className="flex-row flex-wrap gap-2">
        <Button
          variant="secondary"
          icon="arrow-up-right"
          title={t('connect.getApp.appStore')}
          onPress={() => void openExternalUrl(APP_LINKS.ios)}
        />
        <Button
          variant="secondary"
          icon="arrow-up-right"
          title={t('connect.getApp.googlePlay')}
          onPress={() => void openExternalUrl(APP_LINKS.android)}
        />
      </View>
      <Button
        className="self-start"
        variant="link"
        title={t('connect.getApp.apk')}
        onPress={() => void openExternalUrl(APP_LINKS.apk)}
      />
    </View>
  );
}
