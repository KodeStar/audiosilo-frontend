import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { type ApiClient, isRefusedForGood } from '@/api/client';
import { connectClient, connectClientFor } from '@/api/connect-client';
import type { AuthSession, PairingPayload } from '@/api/types';
import { AddressesCard } from '@/components/layout/addresses-card';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { SegmentedControl } from '@/components/ui/toggle-group';
import { onlyOwnServer, servedOrigin } from '@/lib/base-url';
import { getDeviceName } from '@/lib/device';
import { useLayout } from '@/lib/layout';
import { hostOf } from '@/lib/pairing';
import type { ConnectBook } from '@/lib/paths';
import { getSignInKey } from '@/lib/sign-in-key';
import { useSession } from '@/stores/session';

import { ConnectFrame, ConnectInput, StepDots } from './connect-frame';
import { addressesBody, BackToStart } from './connect-parts';
import { finishConnect } from './finish-connect';
import { openScanner } from './invite-handoff';
import { holdOidcIntent } from './oidc-intent';
import { oidcButtonName } from './oidc-sign-in';
import { refusalWaitOver, type SignInStage, signInErrorText } from './sign-in-error';
import { useRefusalError } from './use-refusal-error';

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
 * Sign in with an invite code: redeem it, then exchange its pairing token. A redeem can spend
 * one of the invite's uses, so a token whose exchange got no answer (the network, a 5xx) is
 * handed to `keep`, and the next try of the same code exchanges `kept` instead of redeeming
 * again (fe#159: a second redeem spent another use, and refused a single-use invite as used).
 * A token the server refuses for good (`isRefusedForGood`: spent, or expired meanwhile) is
 * never kept, and a kept one refused so is dropped and the code redeemed.
 * `onStage` hears which request is on its way (`signInErrorText`'s words).
 */
async function signInWithCode(
  client: Pick<ApiClient, 'redeemCode' | 'exchange'>,
  code: string,
  kept: PairingPayload | null,
  keep: (payload: PairingPayload) => void,
  onStage: (stage: SignInStage) => void,
): Promise<{ payload: PairingPayload; session: AuthSession }> {
  const exchange = async (payload: PairingPayload) => {
    onStage('exchange');
    try {
      return { payload, session: await client.exchange(payload.pairing_token, getDeviceName()) };
    } catch (e) {
      if (!isRefusedForGood(e)) keep(payload);
      throw e;
    }
  };
  if (kept) {
    try {
      return await exchange(kept);
    } catch (e) {
      if (!isRefusedForGood(e)) throw e;
    }
  }
  onStage('redeem');
  return exchange(await client.redeemCode(code));
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
 * keeps the reconnect (`reconnectId`, handed over in memory: `openScanner`) for a code of
 * the same server (`scanReconnect`).
 *
 * `initialCode`: an invite link's code (a scanned or pasted invite, #98), filled in and
 * signed in with once, as if typed; a refused one stays in the field with the reason.
 *
 * The step asks the server's `/server` once. Whether it marks its own 401s
 * (`unauthorized_mark`, WS-401-MARK) decides whose a sign-in's 401 is: one without the mark
 * then says something between the device and the server refused it, not a wrong password.
 * The player the server serves, signing in to its own server, also reads whether single
 * sign-on is on (capability `oidc`, server#235) and then offers "Sign in with <name>", a
 * full page load of the server's start route (`oidc-sign-in.ts` has the whole flow).
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
  // A 429's wait gives way to plain words once it is over (`useRefusalError`).
  const [error, setError] = useRefusalError();
  // A field left empty says so under itself, and nothing is sent (CONNECT-09).
  const [missing, setMissing] = useState<Field | null>(null);
  // Typing in a field clears its "enter your ..." prompt.
  const edit = (field: Field, set: (v: string) => void) => (v: string) => {
    set(v);
    if (missing === field) setMissing(null);
  };
  // With the proxy headers entered for `server` on the step before (fe#167), else the set kept
  // for it (one per origin, fe#295). This one only asks whether single sign-on is on and names
  // its start page: a sign-in builds its own client as it is sent (`onSubmit`).
  const api = useMemo(() => connectClient(server), [server]);

  // Single sign-on: only the served player at its own server asks (`oidc-sign-in.ts`). What
  // the flow is for (a grown-up's pass through kids mode, "Add someone", `book`, the
  // connection a reconnect re-pairs with the address it signs in through) goes with the page
  // to the provider and back (`holdOidcIntent`, fe#310).
  const canSso = onlyOwnServer(servedOrigin(), [server]);
  // The button's name once the server said single sign-on is on (`oidcButtonName`).
  const [ssoName, setSsoName] = useState<string | null>(null);
  // Whether the server marks every 401 of its own (`unauthorized_mark`, WS-401-MARK), as its
  // `/server` said: a sign-in's unmarked 401 is then something in front of it refusing, never
  // a wrong password or code (`onSubmit`). Unknown until it answers, and for a server before
  // the mark: the 401's body decides, as before.
  const marks = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    marks.current = undefined;
    const ask = new AbortController();
    api
      .serverInfo(ask.signal)
      .then((info) => {
        if (ask.signal.aborted) return;
        marks.current = info.capabilities?.unauthorized_mark;
        if (canSso) setSsoName(oidcButtonName(info));
      })
      // A server that doesn't answer offers no single sign-on; the other ways stay.
      .catch(() => {});
    return () => ask.abort();
  }, [api, canSso, server]);
  const sso = canSso ? ssoName : null;

  const modes = MODE_VALUES.map((value) => ({
    value,
    label: t(`connect.signIn.mode.${value}`),
  }));

  // One sign-in at a time: the field's return key (or the invite link's own sign-in below)
  // must not redeem the code a second time while one is on its way, which could spend
  // another of the invite's uses.
  const submitting = useRef(false);
  // The code redeemed last whose exchange got no answer, the server it was redeemed at, and
  // its pairing token (`signInWithCode`).
  const redeemed = useRef<{ server: string; code: string; payload: PairingPayload } | null>(null);
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
    // The proxy set read as the sign-in is sent, not as the step opened (fe#295): one changed
    // or removed on the Account page meanwhile is the one that counts.
    const { client, proxy: carried } = connectClientFor(server, undefined, () => marks.current);
    try {
      if (mode === 'code') {
        const typed = code.trim();
        const last = redeemed.current;
        const kept = last?.server === server && last.code === typed ? last.payload : null;
        redeemed.current = null;
        const { payload, session } = await signInWithCode(
          client,
          typed,
          kept,
          (p) => (redeemed.current = { server, code: typed, payload: p }),
          (next) => (stage = next),
        );
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
        const session = await client.login(
          username.trim(),
          password,
          getDeviceName(),
          await getSignInKey(server),
        );
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
      setError(signInErrorText(e, stage, t), refusalWaitOver(e, t));
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
      {sso !== null ? (
        <Button
          size="lg"
          variant="outline"
          title={sso ? t('connect.oidc.signIn', { name: sso }) : t('connect.oidc.signInUnnamed')}
          disabled={loading}
          onPress={() => {
            const tag = holdOidcIntent(book, reconnectId ? { server, reconnectId } : undefined);
            window.location.assign(api.oidcStartUrl(tag));
          }}
          testID="sign-in-oidc"
        />
      ) : null}
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
          onPress={() => openScanner(reconnectId, book)}
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
