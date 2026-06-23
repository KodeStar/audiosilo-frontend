import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { parsePairingScan } from '@/lib/pairing';
import { colors } from '@/theme/tokens';

function CloseControl() {
  const { t } = useTranslation();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('connect.scan.closeLabel')}
      onPress={() => router.back()}
      className="absolute left-4 top-4 z-10 h-10 w-10 items-center justify-center rounded-full bg-black/50 active:opacity-70"
    >
      <Icon name="close" size={20} color={colors.white} />
    </Pressable>
  );
}

export default function ScanScreen() {
  const { t } = useTranslation();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  // Guards against the camera firing onBarcodeScanned repeatedly for the same frame.
  const handling = useRef(false);

  const onScan = ({ data }: BarcodeScanningResult) => {
    if (handling.current) return;
    handling.current = true;
    const parsed = parsePairingScan(data);
    if (!parsed) {
      setError(t('connect.scan.invalidCode'));
      // Let the user re-aim at a different code after a beat.
      setTimeout(() => {
        handling.current = false;
      }, 1500);
      return;
    }
    setError(null);
    // Hand the base + token back to the connect screen, which runs the existing
    // pairing exchange and redirects on success.
    router.replace({ pathname: '/connect', params: { server: parsed.base, token: parsed.token } });
  };

  if (!permission) {
    return (
      <Screen>
        <Spinner center />
      </Screen>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView className="flex-1 bg-gray-200 dark:bg-gray-800">
        <CloseControl />
        <View className="flex-1 items-center justify-center gap-4 p-8">
          <Icon name="qrcode" size={48} color={colors.primary} />
          <Text variant="title" className="text-center">
            {t('connect.scan.permissionTitle')}
          </Text>
          <Text variant="muted" className="text-center">
            {t('connect.scan.permissionMessage')}
          </Text>
          {permission.canAskAgain ? (
            <Button
              title={t('connect.scan.allowCamera')}
              icon="qrcode"
              onPress={requestPermission}
            />
          ) : (
            <Button
              title={t('connect.scan.openSettings')}
              variant="secondary"
              onPress={() => Linking.openSettings()}
            />
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View className="flex-1 bg-black">
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={onScan}
      />
      <SafeAreaView className="flex-1">
        <CloseControl />
        <View className="flex-1 items-end justify-end p-8">
          <Text
            className={`w-full rounded-lg px-4 py-3 text-center text-white ${
              error ? 'bg-red-600/80' : 'bg-black/60'
            }`}
          >
            {error ?? t('connect.scan.aimHint')}
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}
