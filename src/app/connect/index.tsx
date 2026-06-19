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
import { getDeviceName } from '@/lib/device';
import { normalizeUrl } from '@/lib/pairing';
import { useSession } from '@/stores/session';

// webOrigin is the URL the web build is served from (which is also its API base).
// null on native, where the server address must arrive in the link's `server` param.
function webOrigin(): string | null {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return window.location.origin.replace(/\/+$/, '');
  }
  return null;
}

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
      router.push({ pathname: '/connect/sign-in', params: { serverName: info.name } });
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
