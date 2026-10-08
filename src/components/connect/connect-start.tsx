import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { ApiClient, ApiError } from '@/api/client';
import { probeServerId } from '@/api/server-id-probe';
import { Logo } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { webOrigin } from '@/lib/base-url';
import { getDeviceName } from '@/lib/device';
import {
  forget as forgetServer,
  list as listKnownServers,
  type KnownServer,
} from '@/lib/known-servers';
import { useLayout } from '@/lib/layout';
import { cleanAddresses, normalizeUrl, parsePairingScan } from '@/lib/pairing';
import { useSession } from '@/stores/session';

import { BrandLockup, ConnectFrame, ConnectInput, StepDots } from './connect-frame';
import {
  hostOf,
  knownToOffer,
  looksLikeHomeAddress,
  pairingAddresses,
  reconnectAddress,
} from './connect-model';
import { KnownServerRow, type Probe, ProbeNotice } from './connect-parts';
import { CoverFan } from './cover-cascade';
import { finishConnect } from './finish-connect';
import { usePairing } from './use-pairing';

/**
 * The first step of onboarding (`/connect`): "Your audiobooks, from your own server."
 * The address field asks the server who it is (`GET /server`) and says what it found
 * ("Found Hearthside, AudioSilo 1.17.0") or why it couldn't reach it, with Sign in and,
 * when the server runs a demo, Try the demo. Scan a QR code (native) or paste a pairing
 * link (web), and one-tap "Reconnect to <server>" rows for remembered servers.
 *
 * A pairing link or QR opens this screen with its `token` (and on native the `server` it
 * belongs to, and the server's `home` / `away` addresses when it has them): the token is
 * exchanged at once, with nothing to type.
 */
export function ConnectStart() {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const { token, server, home, away } = useLocalSearchParams<{
    token?: string;
    server?: string;
    home?: string;
    away?: string;
  }>();
  const setPendingServerUrl = useSession((s) => s.setPendingServerUrl);
  const savedUrl = useSession((s) => s.pendingServerUrl);
  const connectionIds = useSession((s) => s.connections.map((c) => c.id).join('\n'));
  const [url, setUrl] = useState(savedUrl ?? '');
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
  const { pairing, error: pairError, fail, pair } = usePairing(!!token);

  // A pairing link's token: exchange it once (a language switch must not run it again).
  useEffect(() => {
    if (!token) return;
    const base = server ? normalizeUrl(server) : webOrigin();
    if (!base) {
      fail(t('connect.server.missingAddress'));
      return;
    }
    void pair({ base, token, addresses: cleanAddresses({ home, away }) }).then((ok) => {
      if (!ok) setUrl((u) => u || base);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, server, home, away, pair, fail]);

  // Remembered servers (durable, no token): one-tap reconnect, with zero typing.
  useEffect(() => {
    let cancelled = false;
    void listKnownServers().then((k) => {
      if (!cancelled) setKnown(k);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const goSignIn = (name: string) =>
    router.push({ pathname: '/connect/sign-in', params: { serverName: name } });

  // Ask the server who it is. The typed address shows what was found (or why not); a
  // remembered server goes straight on to sign-in unless it runs a demo.
  const connect = async (target: string, tag: string) => {
    setFieldError(null);
    setDemoError(null);
    setProbe(null);
    const normalized = normalizeUrl(target);
    if (!normalized) {
      setFieldError(t('connect.server.enterAddress'));
      return;
    }
    setBusy(tag);
    try {
      const info = await new ApiClient(normalized).serverInfo();
      await setPendingServerUrl(normalized);
      const found: Probe = {
        kind: 'found',
        base: normalized,
        name: info.name,
        version: info.version,
        demo: !!info.demo?.enabled,
      };
      if (tag !== 'manual' && !found.demo) goSignIn(info.name);
      else setProbe(found);
    } catch (e) {
      setProbe(
        e instanceof ApiError
          ? { kind: 'error', message: e.message }
          : {
              kind: 'unreachable',
              address: hostOf(normalized),
              home: looksLikeHomeAddress(normalized),
            },
      );
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
        addresses: pairingAddresses(undefined, demo.addresses),
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

  const onPasteLink = () => {
    setLinkError(null);
    const scan = parsePairingScan(link);
    if (!scan) {
      setLinkError(t('connect.link.invalid'));
      return;
    }
    void pair(scan);
  };

  if (pairing) {
    return (
      <ConnectFrame>
        <View className="items-center gap-4" accessibilityLiveRegion="polite">
          <Logo size={56} />
          <Spinner size="large" />
          <Text variant="muted">{t('connect.server.connecting')}</Text>
        </View>
      </ConnectFrame>
    );
  }

  const offered = knownToOffer(known, connectionIds ? connectionIds.split('\n') : []);
  const isWeb = Platform.OS === 'web';

  return (
    <ConnectFrame testID="connect-start">
      {phone ? <CoverFan /> : null}
      <BrandLockup />
      <StepDots step={0} />
      <View className="gap-2">
        <Text variant={phone ? 'display' : 'display-xl'} accessibilityRole="header">
          {t('onboarding.start.title')}
        </Text>
        <Text variant="muted" className="text-[15px] leading-[22px]">
          {isWeb ? t('onboarding.start.leadWeb') : t('onboarding.start.lead')}
        </Text>
      </View>
      {pairError ? (
        <Text variant="caption" className="text-destructive" role="alert">
          {pairError}
        </Text>
      ) : null}
      <View className="gap-3">
        {/* The label above the row, so the field and Continue line up at the top. */}
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
        {probe ? (
          <ProbeNotice
            probe={probe}
            onSignIn={() => probe.kind === 'found' && goSignIn(probe.name)}
            onDemo={() => probe.kind === 'found' && onTryDemo(probe.base, probe.name)}
            demoLoading={demoLoading}
          />
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
            }}
            autoCapitalize="none"
            autoCorrect={false}
            inputMode="url"
            error={linkError ?? undefined}
            returnKeyType="go"
            onSubmitEditing={onPasteLink}
          />
          <Button
            className="self-start"
            title={t('connect.link.connect')}
            disabled={!link.trim()}
            onPress={onPasteLink}
          />
        </View>
      ) : null}
      {offered.length > 0 ? (
        <View className="gap-2" role="list">
          <Text variant="eyebrow">{t('reconnect.connect.heading')}</Text>
          {offered.map((entry) => (
            <KnownServerRow
              key={entry.serverId}
              entry={entry}
              busy={busy === entry.serverId}
              disabled={busy !== null}
              onReconnect={() => void onReconnect(entry)}
              onForget={() => onForget(entry.serverId)}
            />
          ))}
        </View>
      ) : null}
    </ConnectFrame>
  );
}
