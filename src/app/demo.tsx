import { Image } from 'expo-image';
import { Redirect, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiClient, ApiError } from '@/api/client';
import type { PairingPayload } from '@/api/types';
import { Logo } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/screen';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { getDeviceName } from '@/lib/device';
import { useSession } from '@/stores/session';

// webOrigin is the URL the web build is served from (also its API base). Demo mode
// is a web-first experience served by the demo server itself.
function webOrigin(): string | null {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return window.location.origin.replace(/\/+$/, '');
  }
  return null;
}

/**
 * Public demo landing. On a demo server (e.g. demo.audiosilo.app), visiting this
 * route instantly provisions a throwaway account, signs this browser in, and shows
 * a QR so the visitor can continue in the app on their phone as the same user.
 */
export default function DemoScreen() {
  const status = useSession((s) => s.status);
  const setSession = useSession((s) => s.setSession);
  const [pairing, setPairing] = useState<PairingPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Provision only while unauthenticated; once setSession flips status to
    // authenticated this re-runs and returns early (no duplicate account). A
    // returning visitor with a live session is redirected home below.
    if (status !== 'unauthenticated') return;
    let cancelled = false;
    (async () => {
      const base = webOrigin();
      if (!base) {
        setError('The demo is available on the web at demo.audiosilo.app.');
        return;
      }
      setError(null);
      try {
        const demo = await new ApiClient(base).demoSession(getDeviceName());
        if (cancelled) return;
        setPairing(demo.pairing);
        await setSession({ serverUrl: base, token: demo.token, user: demo.user });
      } catch (e) {
        if (cancelled) return;
        setError(
          e instanceof ApiError
            ? `Could not start the demo: ${e.message}`
            : 'Could not reach the demo server. Please try again.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, attempt, setSession]);

  if (status === 'loading') {
    return (
      <Screen className="items-center justify-center">
        <Spinner size="large" />
      </Screen>
    );
  }
  // Returning visitor with an existing session and nothing newly provisioned: go in.
  if (status === 'authenticated' && !pairing) {
    return <Redirect href="/" />;
  }

  return (
    <SafeAreaView className="flex-1 bg-gray-200 dark:bg-gray-800">
      <ScrollView contentContainerClassName="flex-grow items-center justify-center gap-8 p-6">
        <View className="items-center gap-3">
          <Logo size={64} />
          <Text className="font-roboto-bold text-3xl text-primary">AudioSilo demo</Text>
          <Text variant="muted" className="text-center">
            A live, read-only demo with public-domain LibriVox audiobooks.
          </Text>
        </View>

        {error ? (
          <View className="items-center gap-4">
            <Text className="text-center text-sm text-red-500">{error}</Text>
            <Button title="Try again" onPress={() => setAttempt((n) => n + 1)} />
          </View>
        ) : !pairing ? (
          <View className="items-center gap-4">
            <Spinner size="large" />
            <Text variant="muted">Setting up your demo…</Text>
          </View>
        ) : (
          <View className="w-full max-w-sm items-center gap-6">
            <View className="rounded-2xl bg-white p-4">
              <Image
                source={{ uri: pairing.qr_png_data_uri }}
                style={{ width: 220, height: 220 }}
                contentFit="contain"
                accessibilityLabel="QR code to open the demo in the app"
              />
            </View>
            <Text variant="muted" className="text-center">
              Scan with your phone to continue in the AudioSilo app, or keep exploring
              in this browser.
            </Text>
            <Button
              title="Browse the demo here"
              icon="play"
              className="w-full"
              onPress={() => router.replace('/')}
            />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
