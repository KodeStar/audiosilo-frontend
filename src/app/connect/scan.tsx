import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { parsePairingScan } from '@/lib/pairing';
import { colors } from '@/theme/tokens';

// Floating close control. Positioned against the live safe-area top inset (not a
// fixed offset) so it lands below the status bar / notch / Dynamic Island where taps
// register - a fixed `top-4` put it up in that non-interactive region. It's a direct
// overlay child (never nested in a padded SafeAreaView, which would double the
// offset) with a generous hitSlop and a high z-index so it sits above the camera.
function CloseControl() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('connect.scan.closeLabel')}
      onPress={() => router.back()}
      hitSlop={12}
      style={{ top: insets.top + 8, left: 16 }}
      className="absolute z-20 h-10 w-10 items-center justify-center rounded-full bg-black/50 active:opacity-70"
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
  // Ensures the automatic first request fires only once.
  const requested = useRef(false);

  // The user reached this screen by tapping "Scan QR code" - that tap is the intent
  // to use the camera, so request permission directly rather than behind a second
  // in-app "Allow camera" button. App Store review flags a custom priming button with
  // directive wording before the system prompt (guideline 5.1.1(iv)); the system
  // prompt on its own is fine, and the post-denial "Open settings" fallback below is
  // explicitly allowed. NSCameraUsageDescription (app.json expo-camera plugin) supplies
  // the "why" inside the OS dialog.
  useEffect(() => {
    if (permission?.status === 'undetermined' && !requested.current) {
      requested.current = true;
      void requestPermission();
    }
  }, [permission, requestPermission]);

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

  // Still loading the status, or the system prompt is on screen (status stays
  // `undetermined` until the user answers): show a spinner behind it.
  if (!permission || permission.status === 'undetermined') {
    return (
      <Screen>
        <Spinner center />
      </Screen>
    );
  }

  if (!permission.granted) {
    // Reached only after the user declined the system prompt. Apple permits informing
    // the user and linking to Settings here; on Android a soft-deny leaves
    // `canAskAgain` true, so offer a neutral in-app retry instead.
    return (
      <View className="flex-1 bg-gray-200 dark:bg-gray-800">
        <CloseControl />
        <SafeAreaView className="flex-1">
          <View className="flex-1 items-center justify-center gap-4 p-8">
            <Icon name="qrcode" size={48} color={colors.primary} />
            <Text variant="title" className="text-center">
              {t('connect.scan.permissionTitle')}
            </Text>
            <Text variant="muted" className="text-center">
              {t('connect.scan.permissionDenied')}
            </Text>
            {permission.canAskAgain ? (
              <Button title={t('connect.scan.tryAgain')} onPress={requestPermission} />
            ) : (
              <Button
                title={t('connect.scan.openSettings')}
                variant="secondary"
                onPress={() => Linking.openSettings()}
              />
            )}
          </View>
        </SafeAreaView>
      </View>
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
      <CloseControl />
      <SafeAreaView className="flex-1" pointerEvents="box-none">
        <View className="flex-1 items-end justify-end p-8" pointerEvents="box-none">
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
