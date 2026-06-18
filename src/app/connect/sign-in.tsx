import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError } from '@/api/client';
import type { AuthSession } from '@/api/types';
import { useOptionalApi } from '@/api/provider';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { TextField } from '@/components/ui/text-field';
import { getDeviceName } from '@/lib/device';
import { useSession } from '@/stores/session';

type Mode = 'code' | 'password';

const MODES: { value: Mode; label: string }[] = [
  { value: 'code', label: 'Auth code' },
  { value: 'password', label: 'Password' },
];

export default function SignInScreen() {
  const api = useOptionalApi();
  const serverUrl = useSession((s) => s.serverUrl);
  const setSession = useSession((s) => s.setSession);
  const { serverName } = useLocalSearchParams<{ serverName?: string }>();

  const [mode, setMode] = useState<Mode>('code');
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reached only with a configured server; bounce back if not.
  if (!api || !serverUrl) {
    return <Redirect href="/connect" />;
  }

  const finish = async (session: AuthSession) => {
    await setSession({ serverUrl, token: session.token, user: session.user });
    router.replace('/');
  };

  const onSubmit = async () => {
    setError(null);
    setLoading(true);
    try {
      if (mode === 'code') {
        const pairing = await api.redeemCode(code.trim());
        const session = await api.exchange(pairing.pairing_token, getDeviceName());
        await finish(session);
      } else {
        const session = await api.login(username.trim(), password, getDeviceName());
        await finish(session);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Sign in failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-gray-200 dark:bg-gray-800">
      <ScrollView
        contentContainerClassName="flex-grow justify-center gap-6 p-6"
        keyboardShouldPersistTaps="handled"
      >
        <View className="items-center gap-1">
          <Text variant="heading">Sign in</Text>
          {serverName ? <Text variant="muted">{serverName}</Text> : null}
        </View>

        <View className="flex-row gap-2 rounded-lg bg-gray-100 p-1 dark:bg-gray-840">
          {MODES.map((m) => {
            const active = mode === m.value;
            return (
              <Pressable
                key={m.value}
                onPress={() => {
                  setMode(m.value);
                  setError(null);
                }}
                className={`flex-1 items-center rounded-md px-3 py-2 ${active ? 'bg-primary' : ''}`}
              >
                <Text
                  className={`font-roboto-medium ${active ? 'text-white dark:text-white' : 'text-gray-600 dark:text-gray-400'}`}
                >
                  {m.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {mode === 'code' ? (
          <TextField
            label="Auth code"
            placeholder="Enter the code from the server"
            value={code}
            onChangeText={setCode}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={onSubmit}
          />
        ) : (
          <View>
            <TextField
              label="Username"
              placeholder="Username"
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="username"
            />
            <TextField
              label="Password"
              placeholder="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={onSubmit}
            />
          </View>
        )}

        {error ? <Text className="text-sm text-red-500">{error}</Text> : null}

        <Button
          title={mode === 'code' ? 'Connect' : 'Sign in'}
          loading={loading}
          onPress={onSubmit}
        />
      </ScrollView>
    </SafeAreaView>
  );
}
