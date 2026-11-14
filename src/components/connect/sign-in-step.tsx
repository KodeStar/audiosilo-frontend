import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { connectClientFor } from '@/api/connect-client';
import { AddressesCard } from '@/components/layout/addresses-card';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { SegmentedControl } from '@/components/ui/toggle-group';
import { servedOrigin } from '@/lib/base-url';
import { getDeviceName } from '@/lib/device';
import { useLayout } from '@/lib/layout';
import { hostOf } from '@/lib/pairing';
import type { ConnectBook } from '@/lib/paths';
import { useSession } from '@/stores/session';

import { ConnectFrame, ConnectInput, StepDots } from './connect-frame';
import { addressesBody, BackToStart } from './connect-parts';
import { finishConnect } from './finish-connect';
import { type SignInStage, signInErrorText } from './sign-in-error';

type Mode = 'code' | 'password';

const MODE_VALUES: Mode[] = ['code', 'password'];

type Field = 'code' | 'username' | 'password';

/** The first field this mode needs that is still empty (a name of spaces is empty), or
 * null when the sign-in can be sent. */
export function emptyField(
  mode: Mode,
  v: { code: string; username: string; password: string },
): Field | null {
  if (mode === 'code') return v.code.trim() ? null : 'code';
  if (!v.username.trim()) return 'username';
  return v.password ? null : 'password';
}

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
 * In the app, "No password? Scan a QR code instead" opens the scanner (fe#264), which
 * keeps the reconnect (`reconnectId`) for a code of the same server (`scanReconnect`).
 *
 * `initialCode`: an invite link's code (a scanned or pasted invite, #98), filled in and
 * signed in with once, as if typed; a refused one stays in the field with the reason.
 */
export function SignInStep({
  server,
  serverName,
  reconnectId,
  initialCode,
  book,
}: {
  server: string;
  serverName?: string;
  reconnectId?: string;
  initialCode?: string;
  /** The book the sign-in ends on (a book link opened signed out). */
  book?: ConnectBook;
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
  // A field left empty says so under itself, and nothing is sent (CONNECT-09).
  const [missing, setMissing] = useState<Field | null>(null);
  // Typing in a field clears its "enter your ..." prompt.
  const edit = (field: Field, set: (v: string) => void) => (v: string) => {
    set(v);
    if (missing === field) setMissing(null);
  };
  // With the proxy headers entered for `server` on the step before (fe#167); a reconnect
  // carries only those or its own connection's, never another person's.
  const { client: api, proxy: carried } = useMemo(
    () => connectClientFor(server, undefined, reconnectId),
    [server, reconnectId],
  );

  const modes = MODE_VALUES.map((value) => ({
    value,
    label: t(`connect.signIn.mode.${value}`),
  }));

  // One sign-in at a time: the field's return key (or the invite link's own sign-in below)
  // must not redeem the code a second time while one is on its way, which could spend
  // another of the invite's uses.
  const submitting = useRef(false);
  const onSubmit = async () => {
    if (submitting.current) return;
    setError(null);
    const empty = emptyField(mode, { code, username, password });
    setMissing(empty);
    if (empty) return;
    submitting.current = true;
    setLoading(true);
    // Which request failed decides the words (`signInErrorText`).
    let stage: SignInStage = mode === 'code' ? 'redeem' : 'login';
    try {
      if (mode === 'code') {
        const payload = await api.redeemCode(code.trim());
        stage = 'exchange';
        const session = await api.exchange(payload.pairing_token, getDeviceName());
        await finishConnect({
          serverUrl: server,
          session,
          linkAddresses: payload.addresses,
          name: payload.server_name || serverName,
          reconnectId,
          book,
          carried,
        });
      } else {
        const session = await api.login(username.trim(), password, getDeviceName());
        await finishConnect({
          serverUrl: server,
          session,
          name: serverName,
          reconnectId,
          book,
          carried,
        });
      }
    } catch (e) {
      setError(signInErrorText(e, stage, t));
      setLoading(false);
    } finally {
      submitting.current = false;
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
          setMissing(null);
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
            onChangeText={edit('code', setCode)}
            error={missing === 'code' ? t('connect.signIn.errors.enterCode') : undefined}
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
            onChangeText={edit('username', setUsername)}
            error={missing === 'username' ? t('connect.signIn.errors.enterUsername') : undefined}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            textContentType="username"
          />
          <ConnectInput
            label={t('connect.signIn.passwordLabel')}
            placeholder={t('connect.signIn.passwordPlaceholder')}
            value={password}
            onChangeText={edit('password', setPassword)}
            error={missing === 'password' ? t('connect.signIn.errors.enterPassword') : undefined}
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
      {/* Most people have no password (an invite pairs a device): in the app, the QR their
          invite page or the console's Pair a device shows signs them in instead (fe#264). The
          scanner hands its code to a new connect step, which pairs at once; a reconnect's goes
          with it, so a code for the same server re-pairs this connection as a code or a
          password typed here does (a server that was reset keeps its person). */}
      {Platform.OS === 'web' ? null : (
        <Button
          variant="link"
          icon="qrcode"
          title={t('connect.signIn.scanInstead')}
          onPress={() =>
            router.push(
              reconnectId
                ? { pathname: '/connect/scan', params: { reconnect: reconnectId } }
                : '/connect/scan',
            )
          }
          // Not while a sign-in is on its way (an invite's code signs in as the step opens):
          // a code scanned then would start a second one under it.
          disabled={loading}
          className="self-center"
          testID="sign-in-scan"
        />
      )}
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
