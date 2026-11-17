import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { scanParams, scanReconnect } from '@/components/connect/connect-model';
import {
  beginInviteSignIn,
  holdReconnect,
  holdScanReconnect,
  peekScanFor,
  takeScanFor,
} from '@/components/connect/invite-handoff';
import { type PairingScan, parseInviteScan, parsePairingScan } from '@/lib/pairing';
import { sameUrl } from '@/lib/server-address';
import { connectBookParams, parseConnectBook } from '@/lib/paths';
import { useRouteParams } from '@/lib/route-params';
import { useSession } from '@/stores/session';
import { colors } from '@/theme/tokens';
import { SafeAreaView } from '@/components/ui/safe-area-view';

// Floating close control. Positioned against the live safe-area top inset (not a
// fixed offset) so it lands below the status bar / notch / Dynamic Island where taps
// register - a fixed `top-4` put it up in that non-interactive region. It's a direct
// overlay child (never nested in a padded SafeAreaView, which would double the
// offset) with a generous hitSlop and a high z-index so it sits above the camera.
function CloseControl() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    // Positioning lives on a plain wrapper: AnimatedPressable owns its `style` (the
    // press animation), so a `style` prop on it would clobber the animation.
    <View style={{ top: insets.top + 8, left: 16 }} className="absolute z-20">
      <AnimatedPressable
        accessibilityRole="button"
        accessibilityLabel={t('connect.scan.closeLabel')}
        onPress={() => router.back()}
        hitSlop={12}
        className="h-10 w-10 items-center justify-center rounded-full bg-black/50"
      >
        <Icon name="close" size={20} color={colors.white} />
      </AnimatedPressable>
    </View>
  );
}

/**
 * `/connect/scan`, the QR scanner. `reconnect`: the connection the sign-in step it was
 * opened from re-pairs (the reconnect banner's), handed over in memory (`openScanner`),
 * never a route param: a link opens this route, and a link must not name a connection to
 * re-pair. A code for that connection's server keeps it (`scanReconnect`), so the scan ends
 * as a sign-in typed on that step would: a server that was reset keeps its person. `book`
 * and `path`: the book that step was heading to (`openScanner`), which the scan's sign-in
 * ends on too, unless the code names its own (fe#299).
 */
export default function ScanScreen() {
  const { t } = useTranslation();
  // Read as it renders, taken once it is on screen (a render can be run again).
  const [reconnect] = useState(peekScanFor);
  useEffect(() => {
    takeScanFor();
  }, []);
  const routeParams = useRouteParams<{ book?: string; path?: string }>();
  const heading = parseConnectBook(routeParams);
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
    // An invite QR (the console's "Invite ready", #98): its code signs in on the sign-in
    // step at once, through the same redeem and exchange a typed code takes.
    const invite = parsed ? null : parseInviteScan(data);
    // The reconnect this scan continues, when the code is for that connection's server.
    const again = (base: string) =>
      scanReconnect(reconnect, base, useSession.getState().connections);
    // The book the sign-in step was heading to goes on only with a code for that step's
    // server: another server's library ids name other books. The code is for it when it
    // continues the step's reconnect (`again`), or when its address, or another one it
    // gives for its server (`home`, `away`), is the step's own (`pendingServerUrl`, read
    // before an invite's sign-in replaces it): a server's code often names its away
    // address while the step was reached at home.
    const step = useSession.getState().pendingServerUrl;
    const bookFor = (code: Pick<PairingScan, 'base' | 'addresses'>, reconnectId?: string) =>
      heading &&
      (reconnectId !== undefined ||
        [code.base, code.addresses?.home, code.addresses?.away].some(
          (url) => !!url && !!step && sameUrl(url, step),
        ))
        ? heading
        : null;
    if (invite) {
      setError(null);
      const reconnectId = again(invite.base);
      // The reconnect goes with it in memory (`holdReconnect`), never in the params.
      beginInviteSignIn(invite, () => {
        if (reconnectId) holdReconnect(invite.base, reconnectId);
        const book = bookFor(invite, reconnectId);
        router.replace(
          book
            ? { pathname: '/connect/sign-in', params: connectBookParams(book) }
            : '/connect/sign-in',
        );
      });
      return;
    }
    if (!parsed) {
      setError(t('connect.scan.invalidCode'));
      // Let the user re-aim at a different code after a beat.
      setTimeout(() => {
        handling.current = false;
      }, 1500);
      return;
    }
    setError(null);
    // Hand the base + token (and the server's home and away addresses, when the code
    // carries them) back to the connect screen, which runs the pairing exchange. The
    // reconnect goes beside it in memory (`holdScanReconnect`), never in the params.
    const reconnectId = again(parsed.base);
    if (reconnectId) holdScanReconnect(parsed.token, reconnectId);
    router.replace({
      pathname: '/connect',
      params: scanParams({
        ...parsed,
        book: parsed.book ?? bookFor(parsed, reconnectId) ?? undefined,
      }),
    });
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
      <View className="flex-1 bg-background">
        <CloseControl />
        <SafeAreaView className="flex-1">
          <View className="flex-1 justify-center">
            <EmptyState
              icon="qrcode"
              title={t('connect.scan.permissionTitle')}
              hint={t('connect.scan.permissionDenied')}
              action={
                permission.canAskAgain
                  ? { label: t('connect.scan.tryAgain'), onPress: requestPermission }
                  : {
                      label: t('connect.scan.openSettings'),
                      icon: 'settings',
                      onPress: () => Linking.openSettings(),
                    }
              }
            />
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
            className={`w-full rounded-lg px-4 py-3 text-center ${
              error ? 'bg-destructive text-destructive-foreground' : 'bg-black/60 text-white'
            }`}
          >
            {error ?? t('connect.scan.aimHint')}
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}
