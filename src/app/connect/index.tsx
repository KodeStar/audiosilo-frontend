import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiClient, ApiError } from '@/api/client';
import { Logo } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/screen';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { TextField } from '@/components/ui/text-field';
import { webOrigin } from '@/lib/base-url';
import { getDeviceName } from '@/lib/device';
import { normalizeUrl } from '@/lib/pairing';
import { useSession } from '@/stores/session';

export default function ConnectServerScreen() {
  // A copy-invite link or pairing QR opens this screen with a single-use pairing
  // `token` (and, on native, the `server` it belongs to). When present we exchange
  // it for a session automatically — no server address or code to type.
  const { token, server } = useLocalSearchParams<{ token?: string; server?: string }>();
  const setServerUrl = useSession((s) => s.setServerUrl);
  const setSession = useSession((s) => s.setSession);
  const savedUrl = useSession((s) => s.serverUrl);
  const [url, setUrl] = useState(savedUrl ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(!!token);
  const [pairError, setPairError] = useState<string | null>(null);
  // Set once we connect to a server that advertises demo mode, enabling a one-tap
  // guest login (handy for app-store review).
  const [demoBase, setDemoBase] = useState<string | null>(null);
  const [demoLoading, setDemoLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      const base = server ? normalizeUrl(server) : webOrigin();
      if (!base) {
        setPairError('This pairing link is missing its server address. Enter it below.');
        setPairing(false);
        return;
      }
      try {
        const session = await new ApiClient(base).exchange(token, getDeviceName());
        if (cancelled) return;
        await setSession({ serverUrl: base, token: session.token, user: session.user });
        router.replace('/');
      } catch (e) {
        if (cancelled) return;
        setPairError(
          e instanceof ApiError
            ? `Pairing failed: ${e.message}. The code may have expired — ask for a new invite.`
            : 'Could not reach the server to finish pairing.',
        );
        setUrl((u) => u || base);
        setPairing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, server, setSession]);

  const onConnect = async () => {
    setError(null);
    const normalized = normalizeUrl(url);
    if (!normalized) {
      setError('Enter your server address');
      return;
    }
    setLoading(true);
    try {
      const info = await new ApiClient(normalized).serverInfo();
      await setServerUrl(normalized);
      if (info.demo?.enabled) {
        setDemoBase(normalized); // reveal the one-tap demo login below
      } else {
        router.push({ pathname: '/connect/sign-in', params: { serverName: info.name } });
      }
    } catch (e) {
      setError(
        e instanceof ApiError
          ? `Server responded with an error: ${e.message}`
          : 'Could not reach that server. Check the address and that it is online.',
      );
    } finally {
      setLoading(false);
    }
  };

  const onTryDemo = async () => {
    if (!demoBase) return;
    setError(null);
    setDemoLoading(true);
    try {
      const demo = await new ApiClient(demoBase).demoSession(getDeviceName());
      await setSession({ serverUrl: demoBase, token: demo.token, user: demo.user });
      router.replace('/');
    } catch (e) {
      setError(
        e instanceof ApiError
          ? `Could not start the demo: ${e.message}`
          : 'Could not reach the demo server.',
      );
    } finally {
      setDemoLoading(false);
    }
  };

  if (pairing) {
    return (
      <Screen className="items-center justify-center gap-4">
        <Logo size={64} />
        <Spinner size="large" />
        <Text variant="muted">Connecting your device…</Text>
      </Screen>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-gray-200 dark:bg-gray-800">
      <ScrollView
        contentContainerClassName="flex-grow justify-center gap-8 p-6"
        keyboardShouldPersistTaps="handled"
      >
        <View className="items-center gap-3">
          <Logo size={64} />
          <Text className="font-roboto-bold text-3xl text-primary">AudioSilo</Text>
          <Text variant="muted">Connect to your audiobook server</Text>
        </View>
        {pairError ? <Text className="text-center text-sm text-red-500">{pairError}</Text> : null}
        <View>
          <TextField
            label="Server address"
            placeholder="https://books.example.com"
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            inputMode="url"
            error={error ?? undefined}
            returnKeyType="go"
            onSubmitEditing={onConnect}
          />
          <Button title="Connect" icon="server" loading={loading} onPress={onConnect} />
        </View>
        {demoBase ? (
          <View className="gap-4">
            <View className="flex-row items-center gap-3">
              <View className="h-px flex-1 bg-gray-300 dark:bg-gray-750" />
              <Text variant="muted">demo server</Text>
              <View className="h-px flex-1 bg-gray-300 dark:bg-gray-750" />
            </View>
            <Text variant="muted" className="text-center">
              This server offers a guest demo — no account needed.
            </Text>
            <Button title="Try the demo" icon="play" loading={demoLoading} onPress={onTryDemo} />
            <Button
              title="Sign in instead"
              variant="secondary"
              onPress={() => router.push('/connect/sign-in')}
            />
          </View>
        ) : null}
        {Platform.OS !== 'web' ? (
          <View className="gap-4">
            <View className="flex-row items-center gap-3">
              <View className="h-px flex-1 bg-gray-300 dark:bg-gray-750" />
              <Text variant="muted">or</Text>
              <View className="h-px flex-1 bg-gray-300 dark:bg-gray-750" />
            </View>
            <Button
              title="Scan QR code"
              icon="qrcode"
              variant="secondary"
              onPress={() => router.push('/connect/scan')}
            />
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
