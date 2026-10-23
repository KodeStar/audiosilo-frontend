import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ApiClient, ApiError } from '@/api/client';
import { AddressesCard } from '@/components/layout/addresses-card';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { SegmentedControl } from '@/components/ui/toggle-group';
import { servedOrigin } from '@/lib/base-url';
import { getDeviceName } from '@/lib/device';
import { useLayout } from '@/lib/layout';
import { hostOf } from '@/lib/pairing';
import { useSession } from '@/stores/session';

import { ConnectFrame, ConnectInput, StepDots } from './connect-frame';
import { addressesBody, BackToStart } from './connect-parts';
import { finishConnect } from './finish-connect';

type Mode = 'code' | 'password';

const MODE_VALUES: Mode[] = ['code', 'password'];

/**
 * The sign-in step: "<server> · <host>", an invite code or a username and password, then
 * `finishConnect`. Talks to the server being connected to with a bare client (not a
 * saved connection yet, and a wrong password's 401 must never flag a reconnect).
 *
 * "At home and away": shown here when the device already knows both of the server's
 * addresses before anything is submitted, which is a reconnect of a connection that has
 * them. An invite code says which addresses the server has only once it is redeemed, and
 * redeeming is the sign-in itself (a redeem can spend one of the invite's uses), so for
 * a new server the card appears on "Your library is ready." instead, never as a guess.
 *
 * `initialCode`: an invite link's code (a scanned or pasted invite, #98), filled in and
 * signed in with once, as if typed; a refused one stays in the field with the reason.
 */
export function SignInStep({
  server,
  serverName,
  reconnectId,
  initialCode,
}: {
  server: string;
  serverName?: string;
  reconnectId?: string;
  initialCode?: string;
}) {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const reconnecting = useSession((s) =>
    reconnectId ? s.connections.find((c) => c.id === reconnectId) : undefined,
  );
  const [mode, setMode] = useState<Mode>('code');
  const [code, setCode] = useState(initialCode ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const api = useMemo(() => new ApiClient(server), [server]);

  const modes = MODE_VALUES.map((value) => ({
    value,
    label: t(`connect.signIn.mode.${value}`),
  }));

  const onSubmit = async () => {
    setError(null);
    setLoading(true);
    try {
      if (mode === 'code') {
        const payload = await api.redeemCode(code.trim());
        const session = await api.exchange(payload.pairing_token, getDeviceName());
        await finishConnect({
          serverUrl: server,
          session,
          linkAddresses: payload.addresses,
          name: payload.server_name || serverName,
          reconnectId,
        });
      } else {
        const session = await api.login(username.trim(), password, getDeviceName());
        await finishConnect({
          serverUrl: server,
          session,
          name: serverName,
          reconnectId,
        });
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('connect.signIn.failed'));
      setLoading(false);
    }
  };

  // The invite link's code signs in at once, one time only.
  const autoSubmitted = useRef(false);
  useEffect(() => {
    if (!initialCode || autoSubmitted.current) return;
    autoSubmitted.current = true;
    void onSubmit();
    // Once, on open: `onSubmit` reads the state the code was filled into.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const name = serverName || reconnecting?.name;
  const host = hostOf(server);
  const known = reconnecting?.addresses;

  return (
    <ConnectFrame testID="sign-in-step">
      <StepDots step={1} />
      <View className="gap-1.5">
        <Text variant="eyebrow">
          {name ? t('onboarding.signIn.eyebrow', { name, host }) : host}
        </Text>
        <Text variant={phone ? 'display' : 'display-xl'} accessibilityRole="header">
          {t('connect.signIn.title')}
        </Text>
      </View>

      <SegmentedControl
        options={modes}
        value={mode}
        accessibilityLabel={t('connect.signIn.modeLabel')}
        onChange={(m) => {
          setMode(m);
          setError(null);
        }}
        scrollable
      />

      {mode === 'code' ? (
        <View className="gap-1.5">
          <ConnectInput
            size="lg"
            className="font-mono tracking-wider"
            label={t('connect.signIn.codeLabel')}
            placeholder={t('connect.signIn.codePlaceholder')}
            value={code}
            onChangeText={setCode}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={onSubmit}
          />
          <Text variant="caption">{t('onboarding.signIn.codeHint')}</Text>
        </View>
      ) : (
        <View className="gap-4">
          <ConnectInput
            label={t('connect.signIn.usernameLabel')}
            placeholder={t('connect.signIn.usernamePlaceholder')}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            textContentType="username"
          />
          <ConnectInput
            label={t('connect.signIn.passwordLabel')}
            placeholder={t('connect.signIn.passwordPlaceholder')}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={onSubmit}
          />
        </View>
      )}

      {known?.home && known.away ? (
        <AddressesCard addresses={known} body={addressesBody(name ?? host, t)} />
      ) : null}

      {error ? (
        <Text variant="caption" className="text-destructive" role="alert">
          {error}
        </Text>
      ) : null}

      <Button size="lg" title={t('connect.signIn.submit')} loading={loading} onPress={onSubmit} />
      {/* The served player's "Back" goes back: to its found card, or to the app the reconnect
          banner was tapped in (the first step there offers no way back into this reconnect). */}
      <BackToStart
        onPress={() =>
          servedOrigin() && router.canGoBack() ? router.back() : router.dismissTo('/connect')
        }
      />
    </ConnectFrame>
  );
}
