import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Platform, View } from 'react-native';

import { ApiClient, ApiError } from '@/api/client';
import { probeServerId } from '@/api/server-id-probe';
import type { ServerInfo } from '@/api/types';
import { Logo } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { leaveOnboarding } from '@/components/shell/leave-onboarding';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { servedOrigin, webOrigin } from '@/lib/base-url';
import { serverIdOf } from '@/lib/connection-id';
import { getDeviceName } from '@/lib/device';
import {
  forget as forgetServer,
  list as listKnownServers,
  type KnownServer,
} from '@/lib/known-servers';
import { useLayout } from '@/lib/layout';
import {
  cleanAddresses,
  hostOf,
  normalizeUrl,
  parseInviteScan,
  parsePairingScan,
} from '@/lib/pairing';
import { firstParam, idParam, parseConnectBook } from '@/lib/paths';
import { sameOrigin } from '@/lib/same-origin';
import { useProfileConnections } from '@/stores/profiles';
import { useSession } from '@/stores/session';

import { BrandLockup, ConnectFrame, ConnectInput, ConnectReveal, StepDots } from './connect-frame';
import {
  httpFallback,
  knownToOffer,
  looksLikeHomeAddress,
  reconnectAddress,
  selfSignedMayBeWhy,
} from './connect-model';
import { KnownServerRow, type Probe, ProbeNotice } from './connect-parts';
import { CoverFan } from './cover-cascade';
import { finishConnect } from './finish-connect';
import { holdInvite } from './invite-handoff';
import { useLinkPairing } from './use-pairing';

/**
 * The first step of onboarding (`/connect`): "Your audiobooks, from your own server."
 * The address field asks the server who it is (`GET /server`) and says what it found
 * ("Found Hearthside, AudioSilo 1.17.0") or why it couldn't reach it, with Sign in and,
 * when the server runs a demo, Try the demo. An address typed without a scheme is tried
 * over https, then once over plain http when https could not connect (`httpFallback`);
 * a server found over http is named as unencrypted. Scan a QR code (native) or paste a pairing
 * link (web), and one-tap "Reconnect to <server>" rows for remembered servers.
 *
 * A pairing link or QR opens this screen with its `token` (and on native the `server` it
 * belongs to, the server's `home` / `away` addresses when it has them, and its id `sid`): the token is
 * exchanged at once, with nothing to type. A link can also name a book to end on (`book` +
 * `path`, the admin console's "Listen in player", with the `uid` it was made for): rebuilt
 * with `bookHref`, never followed as a URL, and when this device is already signed in as
 * that user there the token is left to expire and the book opens at once (`useLinkPairing`,
 * for a pasted link too).
 *
 * The player the server serves at `/web` (`servedOrigin`) asks nothing: it asks its own origin
 * who it is on open and shows what it found, with Sign in, and no address field or remembered
 * servers (the server's CSP lets it reach no other). Only when that fails does the field show,
 * filled in with the origin.
 */
export function ConnectStart() {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const { token, server, home, away, sid, profile, book, path, uid } = useLocalSearchParams<{
    token?: string;
    server?: string;
    home?: string;
    away?: string;
    sid?: string;
    profile?: string;
    book?: string;
    path?: string;
    uid?: string;
  }>();
  // "Add someone" (Phase 8): a new person signs in, maybe on a server this device knows.
  const newPerson = profile === 'new';
  const setPendingServerUrl = useSession((s) => s.setPendingServerUrl);
  const savedUrl = useSession((s) => s.pendingServerUrl);
  // The signed-in servers (`serverIdOf`: a connection id also names its user), one line each.
  const serverIds = useSession((s) => s.connections.map(serverIdOf).join('\n'));
  // The servers of the person listening: a remembered server another person on this device
  // uses is still one this person can sign in to.
  const personServerIds = useProfileConnections().map(serverIdOf);
  // The served player's field, shown only when its own server didn't answer, has the origin.
  const [url, setUrl] = useState(savedUrl ?? servedOrigin() ?? '');
  // The served player's own server: `pending` while asking it, then `found` (the card is the
  // screen). `null` everywhere else (the field), and for a pairing link.
  const [served, setServed] = useState<'pending' | 'found' | null>(() =>
    servedOrigin() && !token ? 'pending' : null,
  );
  const [known, setKnown] = useState<KnownServer[]>([]);
  // Which connect action is in flight (a remembered server's `serverId`, or `'manual'` for
  // the address field), so only the tapped control spins and every other one stays inert
  // for the whole probe (no double submit).
  const [busy, setBusy] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  // A pasted link for another server, on a server's own player (`onPasteLink`).
  const [foreignLink, setForeignLink] = useState<string | null>(null);
  const { pairing, error: pairError, fail, pair } = useLinkPairing(!!token);

  // A pairing link's token: exchange it once (a language switch must not run it again).
  useEffect(() => {
    if (!token) return;
    const base = server ? normalizeUrl(server) : webOrigin();
    if (!base) {
      fail(t('connect.server.missingAddress'));
      return;
    }
    // Expo Router hands back a repeated param as a list (`firstParam`).
    const serverId = firstParam(sid).trim();
    const userId = idParam(uid);
    // A book to end on: an invalid one is no book, and the flow ends as it always does.
    const linked = parseConnectBook({ book, path });
    void pair({
      base,
      token,
      addresses: cleanAddresses({ home, away }),
      ...(serverId ? { serverId } : {}),
      ...(userId ? { userId } : {}),
      ...(linked ? { book: linked } : {}),
    }).then((ok) => {
      if (!ok) setUrl((u) => u || base);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, server, home, away, sid, book, path, uid, pair, fail]);

  // The served player: ask its own server who it is, once.
  useEffect(() => {
    const origin = servedOrigin();
    if (served !== 'pending' || !origin) return;
    // As typed: the card shows, nothing goes on by itself (an origin has its scheme, so
    // there is no http retry).
    void connect(origin, 'manual').then((found) => setServed(found ? 'found' : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remembered servers (durable, no token): one-tap reconnect, with zero typing. Not on the
  // served player, which reaches only its own server.
  useEffect(() => {
    if (servedOrigin()) return;
    let cancelled = false;
    void listKnownServers().then((k) => {
      if (!cancelled) setKnown(k);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Back to where the listener came from (Settings, the profile menu), else the app.
  const closeAdd = () => (router.canGoBack() ? router.back() : leaveOnboarding());

  const goSignIn = (name: string) =>
    router.push({ pathname: '/connect/sign-in', params: { serverName: name } });

  // Ask the server who it is. The typed address and the served player's own server show what
  // was found (or why not); a remembered server goes straight on to sign-in unless it runs a
  // demo. True when the server answered.
  const connect = async (target: string, tag: string): Promise<boolean> => {
    setFieldError(null);
    setDemoError(null);
    setProbe(null);
    const normalized = normalizeUrl(target);
    if (!normalized) {
      setFieldError(t('connect.server.enterAddress'));
      return false;
    }
    setBusy(tag);
    // Typed without a scheme: plain http, tried once when https could not connect (not a
    // server's error), as a server at home often serves only that.
    const http = tag === 'manual' ? httpFallback(target) : null;
    try {
      let base = normalized;
      let info: ServerInfo;
      try {
        info = await new ApiClient(base).serverInfo();
      } catch (e) {
        if (!http || e instanceof ApiError) throw e;
        info = await new ApiClient(http).serverInfo().catch((e2: unknown) => {
          throw e2 instanceof ApiError ? e2 : e;
        });
        base = http;
        setUrl(http);
      }
      await setPendingServerUrl(base);
      const found: Probe = {
        kind: 'found',
        base,
        name: info.name,
        version: info.version,
        demo: !!info.demo?.enabled,
        unencrypted: base.startsWith('http://'),
      };
      if (tag !== 'manual' && !found.demo) goSignIn(info.name);
      else setProbe(found);
      return true;
    } catch (e) {
      setProbe(
        e instanceof ApiError
          ? { kind: 'error', message: e.message }
          : {
              kind: 'unreachable',
              address: hostOf(normalized),
              home: looksLikeHomeAddress(normalized),
              // Only https was tried (no http retry) and a certificate the device can't
              // trust may be why (`selfSignedMayBeWhy`).
              tls: !http && selfSignedMayBeWhy(normalized, e, Platform.OS === 'web'),
            },
      );
      return false;
    } finally {
      setBusy(null);
    }
  };

  // A remembered server with a home address: ask it there first (native), then go on with
  // whichever address answered as its own.
  const onReconnect = async (entry: KnownServer) => {
    setBusy(entry.serverId);
    const target = await reconnectAddress(entry, probeServerId, Platform.OS === 'web');
    setUrl(target);
    await connect(target, entry.serverId);
  };

  const onForget = async (serverId: string) => {
    await forgetServer(serverId);
    setKnown((k) => k.filter((e) => e.serverId !== serverId));
  };

  const onTryDemo = async (base: string, name: string) => {
    setDemoError(null);
    setDemoLoading(true);
    try {
      const demo = await new ApiClient(base).demoSession(getDeviceName());
      await finishConnect({
        serverUrl: base,
        session: demo,
        name,
      });
    } catch (e) {
      setDemoError(
        e instanceof ApiError
          ? t('connect.server.demoError', { message: e.message })
          : t('connect.server.demoReachError'),
      );
    } finally {
      setDemoLoading(false);
    }
  };

  // A pasted pairing link, or an invite link (#98: its code signs in on the sign-in step at
  // once). On the player a server serves, a link for another server goes nowhere: the
  // page may call only its own origin (its CSP's `connect-src 'self'`), so the request
  // would fail as "Could not reach the server" while that server is fine. It says so, and
  // offers to open the link itself (CONNECT-03).
  const onPasteLink = () => {
    setLinkError(null);
    setForeignLink(null);
    const scan = parsePairingScan(link);
    const invite = scan ? null : parseInviteScan(link);
    const base = scan?.base ?? invite?.base;
    if (!base) {
      setLinkError(t('connect.link.invalid'));
      return;
    }
    const own = servedOrigin();
    if (served === 'found' && own && !sameOrigin(base, { origin: own })) {
      setForeignLink(link.trim());
      return;
    }
    if (scan) {
      void pair(scan);
      return;
    }
    if (!invite) return;
    holdInvite(invite);
    void setPendingServerUrl(invite.base).then(() => router.push('/connect/sign-in'));
  };

  if (served === 'pending' || pairing) {
    return (
      <ConnectFrame>
        <View className="items-center gap-4" accessibilityLiveRegion="polite">
          <Logo size={56} />
          <Spinner size="large" />
          <Text variant="muted">
            {pairing ? t('connect.server.connecting') : t('onboarding.start.finding')}
          </Text>
        </View>
      </ConnectFrame>
    );
  }

  const isServed = served === 'found';
  const offered = knownToOffer(known, newPerson ? [] : personServerIds);
  const isWeb = Platform.OS === 'web';
  const lead = isServed
    ? 'onboarding.start.leadServed'
    : isWeb
      ? 'onboarding.start.leadWeb'
      : 'onboarding.start.lead';

  return (
    <ConnectFrame testID="connect-start">
      {/* Adding a server (a connection already exists): a way back to the app. The first
          run has nowhere to go back to. */}
      {serverIds ? (
        <View className="flex-row justify-end">
          <Button
            variant="ghost"
            size="sm"
            icon="close"
            title={t('common.cancel')}
            accessibilityLabel={t('connect.server.cancelAdd')}
            onPress={closeAdd}
            testID="connect-cancel"
          />
        </View>
      ) : null}
      {phone ? <CoverFan /> : null}
      <BrandLockup />
      <StepDots step={0} />
      <View className="gap-2">
        <Text variant={phone ? 'display' : 'display-xl'} accessibilityRole="header">
          {newPerson ? t('profiles.connect.title') : t('onboarding.start.title')}
        </Text>
        <Text variant="muted" className="text-[15px] leading-[22px]">
          {newPerson ? t('profiles.connect.lead') : t(lead)}
        </Text>
      </View>
      {pairError ? (
        <Text variant="caption" className="text-destructive" role="alert">
          {pairError}
        </Text>
      ) : null}
      <View className="gap-3">
        {/* The label above the row, so the field and Continue line up at the top. The served
            player found its own server: no address to ask for. */}
        {isServed ? null : (
          <View className="gap-1.5">
            <Text variant="eyebrow" nativeID="server-address-label">
              {t('connect.server.addressLabel')}
            </Text>
            <View className="flex-row items-start gap-2">
              <View className="min-w-0 flex-1">
                <ConnectInput
                  size="lg"
                  accessibilityLabel={t('connect.server.addressLabel')}
                  aria-labelledby="server-address-label"
                  placeholder="books.example.com"
                  value={url}
                  onChangeText={(v) => {
                    setUrl(v);
                    setProbe(null);
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  inputMode="url"
                  textContentType="URL"
                  error={fieldError ?? undefined}
                  returnKeyType="go"
                  onSubmitEditing={() => connect(url, 'manual')}
                />
              </View>
              <Button
                size="lg"
                className="h-[48px]"
                title={t('onboarding.start.continue')}
                loading={busy === 'manual'}
                disabled={busy !== null}
                onPress={() => connect(url, 'manual')}
              />
            </View>
          </View>
        )}
        {probe ? (
          // Scrolled into view when it appears: the keyboard is usually still up.
          <ConnectReveal testID="probe-reveal">
            <ProbeNotice
              probe={probe}
              onSignIn={() => probe.kind === 'found' && goSignIn(probe.name)}
              onDemo={() => probe.kind === 'found' && onTryDemo(probe.base, probe.name)}
              demoLoading={demoLoading}
            />
          </ConnectReveal>
        ) : null}
        {demoError ? (
          <Text variant="caption" className="text-destructive" role="alert">
            {demoError}
          </Text>
        ) : null}
      </View>
      <View className="flex-row flex-wrap gap-2">
        {isWeb ? (
          <Button
            variant="outline"
            icon="link"
            title={t('connect.link.open')}
            aria-expanded={linkOpen}
            onPress={() => setLinkOpen((o) => !o)}
          />
        ) : (
          <Button
            variant="outline"
            icon="qrcode"
            title={t('connect.server.scanQr')}
            onPress={() => router.push('/connect/scan')}
          />
        )}
      </View>
      {isWeb && linkOpen ? (
        <View className="gap-3">
          <ConnectInput
            label={t('connect.link.label')}
            placeholder="https://books.example.com/web/connect?token=..."
            value={link}
            onChangeText={(v) => {
              setLink(v);
              setLinkError(null);
              setForeignLink(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            inputMode="url"
            error={linkError ?? undefined}
            returnKeyType="go"
            onSubmitEditing={onPasteLink}
          />
          {foreignLink ? (
            <View className="gap-2" testID="connect-link-other-server">
              <Text variant="caption" role="alert">
                {t('connect.link.otherServer')}
              </Text>
              <Button
                className="self-start"
                variant="secondary"
                icon="arrow-up-right"
                title={t('connect.link.openLink')}
                onPress={() => void Linking.openURL(foreignLink)}
              />
            </View>
          ) : (
            <Button
              className="self-start"
              title={t('connect.link.connect')}
              disabled={!link.trim()}
              onPress={onPasteLink}
            />
          )}
        </View>
      ) : null}
      {offered.length > 0 ? (
        <View className="gap-2" role="list">
          <Text variant="eyebrow">
            {newPerson ? t('profiles.connect.knownHeading') : t('reconnect.connect.heading')}
          </Text>
          {offered.map((entry) => (
            <KnownServerRow
              key={entry.serverId}
              entry={entry}
              busy={busy === entry.serverId}
              disabled={busy !== null}
              newPerson={newPerson}
              onReconnect={() => void onReconnect(entry)}
              onForget={() => onForget(entry.serverId)}
            />
          ))}
        </View>
      ) : null}
    </ConnectFrame>
  );
}
