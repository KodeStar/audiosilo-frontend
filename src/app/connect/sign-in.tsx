import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { ApiClient, ApiError } from '@/api/client';
import type { AuthSession } from '@/api/types';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/toggle-group';
import { Text } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { getDeviceName } from '@/lib/device';
import { useSession } from '@/stores/session';
import { SafeAreaView } from '@/components/ui/safe-area-view';

type Mode = 'code' | 'password';

const MODE_VALUES: Mode[] = ['code', 'password'];

export default function SignInScreen() {
  const { t } = useTranslation();
  const pendingServerUrl = useSession((s) => s.pendingServerUrl);
  const setSession = useSession((s) => s.setSession);
  const { serverName } = useLocalSearchParams<{ serverName?: string }>();

  const modes: { value: Mode; label: string }[] = MODE_VALUES.map((value) => ({
    value,
    label: t(`connect.signIn.mode.${value}`),
  }));

  const [mode, setMode] = useState<Mode>('code');
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sign in against the server being connected to (which is not a saved
  // connection yet), so adding a second server doesn't talk to the active one.
  const api = useMemo(
    () => (pendingServerUrl ? new ApiClient(pendingServerUrl) : null),
    [pendingServerUrl],
  );

  // Reached only mid-connect; bounce back if there's no pending server.
  if (!api || !pendingServerUrl) {
    return <Redirect href="/connect" />;
  }

  const finish = async (session: AuthSession) => {
    await setSession({
      serverUrl: pendingServerUrl,
      serverId: session.server_id,
      token: session.token,
      user: session.user,
    });
    // Back to the app, not `replace`: `(app)` is the root stack's anchor and already sits
    // under onboarding, so replacing would stack a second `(app)` on top of it.
    router.dismissTo('/');
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
      setError(e instanceof ApiError ? e.message : t('connect.signIn.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView
        contentContainerClassName="grow justify-center gap-6 p-6"
        keyboardShouldPersistTaps="handled"
      >
        <View className="items-center gap-1">
          <Text variant="heading">{t('connect.signIn.title')}</Text>
          {serverName ? <Text variant="muted">{serverName}</Text> : null}
        </View>

        <SegmentedControl
          options={modes}
          value={mode}
          onChange={(m) => {
            setMode(m);
            setError(null);
          }}
          grow
        />

        {mode === 'code' ? (
          <Input
            containerClassName="mb-4"
            size="lg"
            label={t('connect.signIn.codeLabel')}
            placeholder={t('connect.signIn.codePlaceholder')}
            value={code}
            onChangeText={setCode}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={onSubmit}
          />
        ) : (
          <View>
            <Input
              containerClassName="mb-4"
              label={t('connect.signIn.usernameLabel')}
              placeholder={t('connect.signIn.usernamePlaceholder')}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="username"
            />
            <Input
              containerClassName="mb-4"
              label={t('connect.signIn.passwordLabel')}
              placeholder={t('connect.signIn.passwordPlaceholder')}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={onSubmit}
            />
          </View>
        )}

        {error ? <Text className="text-center text-sm text-destructive">{error}</Text> : null}

        <Button
          size="lg"
          title={mode === 'code' ? t('connect.signIn.connect') : t('connect.signIn.submit')}
          loading={loading}
          onPress={onSubmit}
        />
      </ScrollView>
    </SafeAreaView>
  );
}
