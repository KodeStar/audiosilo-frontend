import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiClient, ApiError } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { TextField } from '@/components/ui/text-field';
import { useSession } from '@/stores/session';

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

export default function ConnectServerScreen() {
  const setServerUrl = useSession((s) => s.setServerUrl);
  const savedUrl = useSession((s) => s.serverUrl);
  const [url, setUrl] = useState(savedUrl ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <SafeAreaView className="flex-1 bg-gray-200 dark:bg-gray-800">
      <ScrollView
        contentContainerClassName="flex-grow justify-center gap-8 p-6"
        keyboardShouldPersistTaps="handled"
      >
        <View className="items-center gap-2">
          <Text className="font-roboto-bold text-3xl text-primary">AudioSilo</Text>
          <Text variant="muted">Connect to your audiobook server</Text>
        </View>
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
      </ScrollView>
    </SafeAreaView>
  );
}
