import { router, useNavigation } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { ApiError } from '@/api/client';
import { connectClient, connectClientFor } from '@/api/connect-client';
import { probeServerId } from '@/api/server-id-probe';
import type { ServerInfo } from '@/api/types';
import { Logo } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { leaveOnboarding } from '@/components/shell/leave-onboarding';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { onlyOwnServer, servedOrigin, webOrigin } from '@/lib/base-url';
import { serverIdOf } from '@/lib/connection-id';
import { getDeviceName } from '@/lib/device';
import {
  forget as forgetServer,
  list as listKnownServers,
  type KnownServer,
} from '@/lib/known-servers';
import { useLayout } from '@/lib/layout';
import { useLargeText } from '@/lib/text-scale';
import {
  cleanAddresses,
  hostOf,
  normalizeUrl,
  parseInviteScan,
  parsePairingScan,
  type PairingScan,
} from '@/lib/pairing';
import { connectBookParams, firstParam, idParam, parseConnectBook } from '@/lib/paths';
import { originOf, proxyOriginOf, sameProxyHeaders } from '@/lib/proxy-headers';
import { useRouteParams } from '@/lib/route-params';
import { sameOrigin } from '@/lib/same-origin';
import { openExternalUrl } from '@/lib/support';
import { looksLikeHomeAddress } from '@/lib/url-host';
import { useProfileConnections } from '@/stores/profiles';
import { useSession } from '@/stores/session';

import { BrandLockup, ConnectFrame, ConnectInput, ConnectReveal, StepDots } from './connect-frame';
import {
  httpFallback,
  knownToOffer,
  proxyOriginsToForget,
  reconnectAddress,
  scanReconnect,
  selfSignedMayBeWhy,
  unusedProxySet,
} from './connect-model';
import { KnownServerRow, type Probe, ProbeNotice } from './connect-parts';
import { CoverFan } from './cover-cascade';
import { finishConnect } from './finish-connect';
import {
  beginInviteSignIn,
  openScanner,
  peekScanReconnect,
  takeScanReconnect,
  useHandoff,
} from './invite-handoff';
import { settleOidcPass } from './oidc-intent';
import {
  finishOidcSignIn,
  type OidcFinishFailure,
  type OidcFinishRetry,
  oidcDoneLeft,
  oidcFlowKey,
  oidcReturnCleared,
  oidcReturnOrigin,
} from './oidc-sign-in';
import { ProxyHeadersEditor } from './proxy-headers-editor';
import { draftOf, draftToSet, type HeaderDraftRow } from './proxy-headers-model';
import { sharedRefusalText } from './sign-in-error';
import { useLinkPairing } from './use-pairing';

/**
 * The first step of onboarding (`/connect`): "Your audiobooks, from your own server."
 * The address field asks the server who it is (`GET /server`) and says what it found
 * ("Found Hearthside, AudioSilo 1.17.0") or why it couldn't reach it, with Sign in and,
 * when the server runs a demo, Try the demo. An address typed without a scheme is tried
 * over https, then once over plain http when https could not connect (`httpFallback`);
 * a server found over http is named as unencrypted. Scan a QR code (native) or paste a pairing
 * link (web), and one-tap "Reconnect to <server>" rows for remembered servers. In the app,
 * Scan a QR code is the first action (full width, the one primary) and the address field is
 * under "Or enter the server address"; the lead says where the QR is (fe#264).
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
 * servers (the server's CSP lets it reach no other). Only when that fails (or Cancel is
 * pressed while it asks) does the field show, filled in with the origin.
 *
 * The served player opened as `?oidc=1` is the server's return from a single sign-on
 * (server#235, started on the sign-in step): the sign-in is finished at once
 * (`finishOidcSignIn`, with the `flow` the return names), the params queued off the address
 * before the finish is sent so a reload never tries it again; a failure says why above its
 * own server's card, as a dead pairing link does, with Try again when the server kept the
 * sign-in (`oidcRetryWait`): the same finish, from memory, until the server's done cookie's
 * minute is over (`OIDC_DONE_MS`).
 */
export function ConnectStart() {
  const { t } = useTranslation();
  const large = useLargeText();
  const phone = useLayout() === 'phone';
  const { token, server, home, away, sid, profile, book, path, uid, oidc, flow } = useRouteParams<{
    token?: string;
    oidc?: string;
    flow?: string;
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
  // Proxy headers the flow already holds (fe#167): the scanner hands a code back to a new
  // instance of this screen, which must take them up, not drop them.
  const heldProxy = useSession.getState().pendingProxyHeaders;
  // The server's return from a single sign-on, on the player it serves (read once: the
  // param leaves the address as the finish starts). A pairing link wins.
  const [oidcOrigin] = useState(() => oidcReturnOrigin(oidc, token));
  // The flow it names (`&flow=`, server#406), read with it, so the finish takes this tab's
  // own sign-in whatever the router does with the params once they are taken off.
  const [oidcFlow] = useState(() => oidcFlowKey(flow));
  // Opened by a link (a pairing token or a single sign-on's return): it runs at once, with
  // no address field or served card until it fails.
  const linkFlow = !!token || oidcOrigin !== null;
  // The served player's field, shown only when its own server didn't answer, has the origin.
  const [url, setUrl] = useState(savedUrl ?? servedOrigin() ?? heldProxy?.origin ?? '');
  // The address as the listener typed it: what proxy headers are for. Never the field after
  // the flow rewrites it (a plain-http fallback, a remembered server's home address), so
  // headers entered for https are never rebound to another origin.
  const [typedUrl, setTypedUrl] = useState(() => heldProxy?.origin ?? url);
  // The served player's own server: `pending` while asking it, then `found` (the card is the
  // screen). `null` everywhere else (the field), and for a pairing link.
  const [served, setServed] = useState<'pending' | 'found' | null>(() =>
    servedOrigin() && !linkFlow ? 'pending' : null,
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
  const { pairing, error: pairError, fail, pair, clear: clearPairError } = useLinkPairing(linkFlow);
  // A pairing link that failed for a reason that can pass (`PairOutcome` `temporary`).
  const [retryLink, setRetryLink] = useState<PairingScan | null>(null);
  // A single sign-on's finish the server kept the sign-in for (`OidcFinishFailure.retry`):
  // Try again sends it once its `waitMs` is down to 0, and the finish runs meanwhile
  // (`oidcFinishing`) as the first did, under "Connecting".
  const [oidcRetry, setOidcRetry] = useState<OidcFinishRetry | null>(null);
  // The wait, and the done cookie's minute (`doneBy`), run while this retry is the one offered:
  // dropping it (or the screen) ends them. Past the minute the server holds the sign-in no
  // more, so Try again goes and the reason is the refusal's: only Sign in again is left.
  // The minute is absolute (`oidcDoneLeft`), so re-arming it (a language switch) moves
  // nothing; the wait is relative, so only a new retry re-arms it.
  useEffect(() => {
    if (!oidcRetry) return;
    const id = setTimeout(() => {
      setOidcRetry(null);
      fail(t('connect.oidc.errors.expired'));
    }, oidcDoneLeft(oidcRetry.doneBy));
    return () => clearTimeout(id);
  }, [oidcRetry, fail, t]);
  useEffect(() => {
    if (!oidcRetry?.waitMs) return;
    const id = setTimeout(() => setOidcRetry({ ...oidcRetry, waitMs: 0 }), oidcRetry.waitMs);
    return () => clearTimeout(id);
  }, [oidcRetry]);
  const [oidcFinishing, setOidcFinishing] = useState(false);
  // The reconnect the code that opened this screen continues (scanned from a reconnect's
  // sign-in step, `holdScanReconnect`): taken once, and only that code's (Try again too),
  // never a link pasted or opened later (`useHandoff`).
  const scanned = useHandoff(
    () => {
      const reconnectId = token ? peekScanReconnect(token) : undefined;
      return reconnectId ? { token, reconnectId } : null;
    },
    () => {
      if (token) takeScanReconnect(token);
    },
  );
  // Custom headers for an auth proxy in front of the server (fe#167), for the address the
  // listener typed: handed to the session for the connect flow's clients
  // (`connectProxyHeaders`) as the flow moves on (`holdTyped`: Continue, a remembered server,
  // a link, the scanner, sign-in, the demo), never at each keystroke, and kept as that
  // address's set once a sign-in gets in with them. Closing the section only hides them (it
  // says how many are held). The flow's layout drops them when the flow is left. Values
  // already held come back hidden.
  const [proxyOpen, setProxyOpen] = useState(() => !!heldProxy);
  const [proxyRows, setProxyRows] = useState<HeaderDraftRow[]>(() => draftOf(heldProxy));
  const setPendingProxyHeaders = useSession((s) => s.setPendingProxyHeaders);
  // Only an https address takes them (never sent over plain http); an http one says so.
  const typedOrigin = originOf(normalizeUrl(typedUrl));
  const proxyOrigin = typedOrigin ? proxyOriginOf(typedOrigin) : null;
  const typedSet = draftToSet(proxyOrigin, proxyRows);
  // The set this device keeps for that address while nobody is signed in through it
  // (fe#295): it goes with the flow's requests there, and this is the one place it can be
  // seen and removed (the Account page's card needs a connection).
  const keptUnused = useSession((s) => unusedProxySet(proxyOrigin, s.proxySets, s.connections));
  const [confirmForgetKept, setConfirmForgetKept] = useState(false);
  const forgetKept = async () => {
    setConfirmForgetKept(false);
    // A removal that can't be stored leaves the set, and its line here, as they were.
    if (keptUnused) {
      await useSession
        .getState()
        .setProxySet(keptUnused.origin, null)
        .catch(() => undefined);
    }
  };
  // `address`: the one the headers are for when this very handler set it (the state is not
  // read again until the next render). A handler that goes on after an await holds them
  // before it, never after: its render's rows and address are stale by then.
  const holdTyped = (address?: string) => {
    const typed = address === undefined ? typedSet : setFor(address, proxyRows);
    if (!sameProxyHeaders(useSession.getState().pendingProxyHeaders, typed)) {
      setPendingProxyHeaders(typed);
    }
  };
  // An address the flow fills in by itself (a link that failed, a remembered server) is the
  // headers' address too, when the listener typed none: never over one they typed, so a set
  // is never moved to an address it was not entered for.
  const fillAddress = (address: string) => {
    setUrl((u) => u || address);
    setTypedUrl((u) => u || address);
  };
  // `pair` also resolves once the screen has gone: nothing after it may then touch
  // the route now on top (its params) or the session (a probe's pending address).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Exchange a pairing link from the address (and again from Try again). A dead link's
  // token leaves the address, so a reload doesn't try it again, and the served player
  // shows its own server's card with Sign in, as it does with no link: never the address
  // field it otherwise skips (CONNECT-14). A link that may work in a moment (the server
  // busy, failing or not answering) keeps its token for a reload, and offers Try again.
  const pairLink = async (scan: PairingScan) => {
    holdTyped();
    setRetryLink(null);
    // A single sign-on's Try again is about that sign-in, not this link.
    setOidcRetry(null);
    // The scanned code's reconnect, and still only for one of that connection's own
    // addresses: a link carrying the same token for another address re-pairs nothing.
    const outcome = await pair(
      scan,
      scanned?.token === scan.token
        ? scanReconnect(scanned.reconnectId, scan.base, useSession.getState().connections)
        : undefined,
    );
    if (outcome === 'paired' || !mounted.current) return;
    if (outcome === 'temporary') {
      setRetryLink(scan);
      fillAddress(scan.base);
      return;
    }
    router.setParams({ token: undefined });
    const origin = servedOrigin();
    // A pasted link (or Try again) on the card already found: the card stays as it is.
    if (origin && served === 'found') return;
    if (origin) showServedCard(origin);
    else fillAddress(scan.base);
  };

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
    const scan: PairingScan = {
      base,
      token,
      addresses: cleanAddresses({ home, away }),
      ...(serverId ? { serverId } : {}),
      ...(userId ? { userId } : {}),
      ...(linked ? { book: linked } : {}),
    };
    void pairLink(scan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, server, home, away, sid, book, path, uid, pair, fail]);

  // A single sign-on's return: finish it once, with `?oidc=1` queued off the address before
  // the finish is sent (a reload must not send it again: only Try again does, from memory). A
  // failure shows its own server's card under the reason, as a dead pairing link does; a
  // screen gone before the answer keeps no session (`finishOidcSignIn`'s `live`).
  const oidcStarted = useRef(false);
  // The screen's own navigation: this runs as the screen mounts, on a page load, where a
  // router's `setParams` reaches nothing yet (CONVENTIONS.md, "Navigation at mount").
  const navigation = useNavigation<{ setParams(params: typeof oidcReturnCleared): void }>();
  useEffect(() => {
    if (oidcStarted.current) return;
    if (!oidcOrigin) {
      // No return to finish here. A grown-up's pass through kids mode still waiting on one
      // (the layout holds kids mode back for the return's own screen only) gets no answer
      // from this screen, so it is refused now and kids mode takes the flow back.
      settleOidcPass(null);
      return;
    }
    oidcStarted.current = true;
    navigation.setParams(oidcReturnCleared);
    void finishOidcSignIn(oidcOrigin, t, () => mounted.current, oidcFlow).then((failure) => {
      if (failure === null || !mounted.current) return;
      // A backstop once settled, when the navigators surely listen: the reason must not sit
      // under an address that would try the finish again.
      router.setParams(oidcReturnCleared);
      oidcFailed(failure);
      showServedCard(oidcOrigin);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A failed finish says why, with its retry when the server left room for one
  // (`oidcRetryWait`); none: the sign-in is refused, so Sign in again.
  const oidcFailed = ({ message, retry, waitOver }: OidcFinishFailure) => {
    fail(message, waitOver);
    setOidcRetry(retry ?? null);
  };
  const retryOidc = () => {
    if (!oidcRetry || oidcRetry.waitMs > 0) return;
    const { run } = oidcRetry;
    setOidcRetry(null);
    clearPairError();
    setOidcFinishing(true);
    void run().then((failure) => {
      // Signed in: the flow moves on, still under "Connecting".
      if (failure === null || !mounted.current) return;
      setOidcFinishing(false);
      oidcFailed(failure);
    });
  };

  // The served player: ask its own server who it is, once.
  useEffect(() => {
    const origin = servedOrigin();
    if (served !== 'pending' || !origin) return;
    showServedCard(origin);
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

  // A book the signed-out visit was opening (`signedOutHref`) goes along, so the sign-in
  // ends on it (frontend#129). A pairing link's book goes through `pair` instead.
  const returnBook = token ? null : parseConnectBook({ book, path });
  // Moving on to another address (Continue, a remembered server) or sign-in: a pairing link's
  // error and its Try again are about the link, not this address, and go (fe#159).
  const moveOn = () => {
    setRetryLink(null);
    setOidcRetry(null);
    clearPairError();
  };

  // The screen stays under the sign-in flow (Back from the sign-in step, or from "Your library
  // is ready."), so leaving for it moves on too: no stale reason, no Try again to finish.
  const goSignIn = (name: string) => {
    moveOn();
    router.push({
      pathname: '/connect/sign-in',
      params: {
        serverName: name,
        ...(returnBook ? connectBookParams(returnBook) : {}),
      },
    });
  };

  // The served player's own server's card: ask it who it is, as typed (the card shows,
  // nothing goes on by itself; an origin has its scheme, so there is no http retry). The ask
  // ends with the screen, or with Cancel on "Finding your server" (`cancelServed`), and then
  // records nothing (fe#159).
  const servedAsk = useRef<AbortController | null>(null);
  useEffect(() => () => servedAsk.current?.abort(), []);
  const showServedCard = (origin: string) => {
    servedAsk.current?.abort();
    const ask = new AbortController();
    servedAsk.current = ask;
    setServed('pending');
    void connect(origin, 'manual', ask.signal, true).then((found) => {
      if (!ask.signal.aborted) setServed(found ? 'found' : null);
    });
  };
  // Cancel on "Finding your server": the address field, filled in with the origin.
  const cancelServed = () => {
    servedAsk.current?.abort();
    servedAsk.current = null;
    setBusy(null);
    setServed(null);
  };

  // Ask the server who it is. The typed address and the served player's own server show what
  // was found (or why not); a remembered server goes straight on to sign-in unless it runs a
  // demo. True when the server answered. Nothing is recorded once the screen is gone or the
  // ask was cancelled (`signal`): not the pending address, nor what was found. `own`: the
  // served player asking its own origin, which nobody typed.
  const connect = async (
    target: string,
    tag: string,
    signal?: AbortSignal,
    own = false,
  ): Promise<boolean> => {
    setFieldError(null);
    setDemoError(null);
    setProbe(null);
    const normalized = normalizeUrl(target);
    if (!normalized) {
      setFieldError(t('connect.server.enterAddress'));
      return false;
    }
    setBusy(tag);
    const gone = () => !mounted.current || !!signal?.aborted;
    // Typed without a scheme: plain http, tried once when https could not connect (not a
    // server's error), as a server at home often serves only that.
    const http = tag === 'manual' ? httpFallback(target) : null;
    try {
      let base = normalized;
      let info: ServerInfo;
      try {
        info = await connectClient(base).serverInfo(signal);
      } catch (e) {
        if (!http || e instanceof ApiError || signal?.aborted) throw e;
        info = await connectClient(http)
          .serverInfo(signal)
          .catch((e2: unknown) => {
            throw e2 instanceof ApiError ? e2 : e;
          });
        base = http;
        setUrl(http);
      }
      if (gone()) return false;
      await setPendingServerUrl(base);
      // A Cancel while the address was written: the field stays, the card doesn't come back.
      if (gone()) return false;
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
      // The served player can reach only its own server: found by a Continue after its own
      // ask failed, it is that server's card, with no address field beside it (fe#159).
      if (tag === 'manual' && onlyOwnServer(servedOrigin(), [base])) setServed('found');
      return true;
    } catch (e) {
      if (gone()) return false;
      // The page's own origin answered, but not as an AudioSilo server (a 404, or a page
      // that isn't JSON): a production build hosted on a site of its own, beside servers
      // that let it in. No error about an address nobody typed, and an empty field
      // (CONNECT-11). A server that is down, or answers with its own error, still says so.
      if (own && e instanceof ApiError && (e.status === 404 || e.status < 300)) {
        setUrl((u) => (u === target ? '' : u));
        setTypedUrl((u) => (u === target ? '' : u));
        return false;
      }
      setProbe(
        e instanceof ApiError
          ? {
              kind: 'error',
              // An auth proxy's own 401 (fe#295) or a 429: what to do about it, not the raw status.
              message: sharedRefusalText(e, t) ?? e.message,
            }
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
      // A cancelled ask leaves `busy` to whoever cancelled it (`cancelServed`, or the ask
      // that replaced it), so its late end can't free Continue while another is on its way.
      if (!signal?.aborted) setBusy(null);
    }
  };

  // A remembered server with a home address: ask it there first (native), then go on with
  // whichever address answered as its own.
  const onReconnect = async (entry: KnownServer) => {
    moveOn();
    // Headers typed with no address are for this server's (its paired one, never the home
    // address the probe may choose); a set kept for that address needs no typing (fe#295).
    const headersFor = typedUrl || entry.serverUrl;
    setTypedUrl(headersFor);
    holdTyped(headersFor);
    setBusy(entry.serverId);
    const target = await reconnectAddress(entry, probeServerId, Platform.OS === 'web');
    setUrl(target);
    await connect(target, entry.serverId);
  };

  // Continue with the typed address.
  const onContinue = () => {
    moveOn();
    holdTyped();
    void connect(url, 'manual');
  };

  const onForget = async (serverId: string) => {
    const entry = known.find((e) => e.serverId === serverId);
    const rest = known.filter((e) => e.serverId !== serverId);
    await forgetServer(serverId);
    setKnown((k) => k.filter((e) => e.serverId !== serverId));
    if (!entry) return;
    // The proxy headers kept for its addresses go with it, unless someone signed in (or
    // another remembered server) still reaches them: nothing else would ever remove them.
    const { proxySets, connections, setProxySet } = useSession.getState();
    const gone = proxyOriginsToForget(entry, proxySets, [...connections, ...rest]);
    await Promise.all(gone.map((origin) => setProxySet(origin, null).catch(() => undefined)));
  };

  const onTryDemo = async (base: string, name: string) => {
    setOidcRetry(null);
    setDemoError(null);
    setDemoLoading(true);
    holdTyped();
    try {
      const { client, proxy: carried } = connectClientFor(base);
      const demo = await client.demoSession(getDeviceName());
      await finishConnect({
        serverUrl: base,
        session: demo,
        name,
        carried,
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
    if (scan) void pairLink(scan);
    else if (invite) {
      // On to the sign-in step, as `goSignIn`: Back finds no stale reason or Try again.
      moveOn();
      holdTyped();
      beginInviteSignIn(invite, () => router.push('/connect/sign-in'));
    }
  };

  const connecting = pairing || oidcFinishing;
  if (served === 'pending' || connecting) {
    return (
      <ConnectFrame>
        <View className="items-center gap-4" accessibilityLiveRegion="polite">
          <Logo size={56} />
          <Spinner size="large" />
          <Text variant="muted">
            {connecting ? t('connect.server.connecting') : t('onboarding.start.finding')}
          </Text>
          {connecting ? null : (
            <Button
              variant="ghost"
              title={t('common.cancel')}
              onPress={cancelServed}
              testID="connect-finding-cancel"
            />
          )}
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
        <Text
          variant="muted"
          className="text-[15px] web:text-[0.9375rem] leading-[22px] web:leading-[1.375rem]"
        >
          {newPerson
            ? // The served player reaches only its own server: no "or theirs" (fe#160).
              t(isServed ? 'profiles.connect.leadServed' : 'profiles.connect.lead')
            : t(lead)}
        </Text>
      </View>
      {pairError ? (
        <Text variant="caption" className="text-destructive" role="alert">
          {pairError}
        </Text>
      ) : null}
      {pairError && retryLink ? (
        <Button
          variant="outline"
          icon="rotate"
          title={t('connect.server.pairingTryAgain')}
          onPress={() => void pairLink(retryLink)}
          testID="pairing-try-again"
        />
      ) : null}
      {pairError && oidcRetry ? (
        <Button
          variant="outline"
          icon="rotate"
          title={t('connect.oidc.tryAgain')}
          disabled={oidcRetry.waitMs > 0}
          onPress={retryOidc}
          testID="oidc-try-again"
        />
      ) : null}
      {/* The app's first action is the QR (fe#264): the console's Pair a device or an invite
          page shows one, and scanning it signs in with nothing to type. The address is the
          fallback under it. The web has no camera: it pastes a link instead (below). */}
      {isWeb ? null : (
        <Button
          size="lg"
          // One primary at a time: once an address is found, its Sign in is the next step.
          variant={probe?.kind === 'found' ? 'secondary' : 'default'}
          icon="qrcode"
          title={t('connect.server.scanQr')}
          // No reconnect from here: it also drops one an earlier scanner never took. The
          // screen the scanner hands its code to takes the headers up (`heldProxy`).
          onPress={() => {
            holdTyped();
            openScanner();
          }}
          testID="connect-scan"
        />
      )}
      <View className="gap-3">
        {/* The label above the row, so the field and Continue line up at the top. The served
            player found its own server: no address to ask for. */}
        {isServed ? null : (
          <View className="gap-1.5">
            <Text variant="eyebrow" nativeID="server-address-label">
              {isWeb ? t('connect.server.addressLabel') : t('connect.server.orAddress')}
            </Text>
            {/* Under large text Continue goes under the field, which keeps the width. */}
            <View className={large ? 'gap-2' : 'flex-row items-start gap-2'}>
              <View className={large ? undefined : 'min-w-0 flex-1'}>
                <ConnectInput
                  size="lg"
                  accessibilityLabel={t('connect.server.addressLabel')}
                  // In the app the label above says "Or enter the server address": the
                  // field's own name stays "Server address".
                  aria-labelledby={isWeb ? 'server-address-label' : undefined}
                  placeholder="books.example.com"
                  value={url}
                  onChangeText={(v) => {
                    setUrl(v);
                    setTypedUrl(v);
                    setProbe(null);
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  inputMode="url"
                  textContentType="URL"
                  error={fieldError ?? undefined}
                  returnKeyType="go"
                  onSubmitEditing={onContinue}
                />
              </View>
              <Button
                size="lg"
                // One primary per screen: in the app that is Scan a QR code.
                variant={isWeb ? 'default' : 'secondary'}
                className="min-h-[48px]"
                title={t('onboarding.start.continue')}
                loading={busy === 'manual'}
                disabled={busy !== null}
                onPress={onContinue}
              />
            </View>
          </View>
        )}
        {probe ? (
          // Scrolled into view when it appears: the keyboard is usually still up.
          <ConnectReveal testID="probe-reveal">
            <ProbeNotice
              probe={probe}
              onSignIn={() => {
                if (probe.kind !== 'found') return;
                holdTyped();
                goSignIn(probe.name);
              }}
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
        ) : null}
        {isServed ? null : (
          <Button
            variant="ghost"
            icon="key"
            title={t('proxyHeaders.toggle')}
            aria-expanded={proxyOpen}
            onPress={() => setProxyOpen((o) => !o)}
            testID="proxy-headers-toggle"
          />
        )}
      </View>
      {!proxyOpen && !isServed && typedSet ? (
        // Closed, not dropped: what is held still goes with the flow's requests.
        <Text variant="caption" testID="proxy-headers-held">
          {t('proxyHeaders.held', { count: typedSet.headers.length, origin: typedSet.origin })}
        </Text>
      ) : null}
      {proxyOpen && !isServed ? (
        <View className="gap-3" testID="proxy-headers-section">
          <Text variant="caption">
            {proxyOrigin
              ? t('proxyHeaders.connectBody', { origin: proxyOrigin })
              : typedOrigin
                ? t('proxyHeaders.connectHttp')
                : t('proxyHeaders.connectNoAddress')}
          </Text>
          {keptUnused && !typedSet ? (
            <View className="flex-row flex-wrap items-center gap-2" testID="proxy-headers-kept">
              <Text variant="caption" className="min-w-0 flex-1">
                {t('proxyHeaders.held', {
                  count: keptUnused.headers.length,
                  origin: keptUnused.origin,
                })}
              </Text>
              <Button
                variant="destructive-outline"
                size="sm"
                icon="trash"
                title={t('proxyHeaders.removeAll')}
                onPress={() => setConfirmForgetKept(true)}
                testID="proxy-headers-kept-remove"
              />
            </View>
          ) : null}
          <ProxyHeadersEditor rows={proxyRows} onChange={setProxyRows} />
          <Text variant="caption">
            {isWeb ? t('proxyHeaders.webNote') : t('proxyHeaders.notCarried')}
          </Text>
          <ConfirmDialog
            visible={confirmForgetKept}
            title={t('proxyHeaders.removeTitle')}
            message={t('proxyHeaders.removeBody')}
            confirmLabel={t('proxyHeaders.removeAll')}
            confirmIcon="trash"
            destructive
            onConfirm={() => void forgetKept()}
            onCancel={() => setConfirmForgetKept(false)}
          />
        </View>
      ) : null}
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
              {/* An app link (`audiosilo://`) can't open in a browser: no button for it. */}
              {isAppLink(foreignLink) ? (
                <Text variant="caption" role="alert">
                  {t('connect.link.appOnly')}
                </Text>
              ) : (
                <>
                  <Text variant="caption" role="alert">
                    {t('connect.link.otherServer')}
                  </Text>
                  <Button
                    className="self-start"
                    variant="secondary"
                    icon="arrow-up-right"
                    title={t('connect.link.openLink')}
                    onPress={() => void openExternalUrl(foreignLink)}
                  />
                </>
              )}
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

/** The set the editor's rows make for the address `typed` as the listener entered it (none
 * unless it is an https one). */
function setFor(typed: string, rows: readonly HeaderDraftRow[]) {
  return draftToSet(proxyOriginOf(normalizeUrl(typed)), rows);
}

/** A link for the AudioSilo app (`audiosilo://`), which a browser can't open. */
function isAppLink(link: string): boolean {
  return /^audiosilo:/i.test(link.trim());
}
