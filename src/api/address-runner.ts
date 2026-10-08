import * as Network from 'expo-network';
import { AppState, Platform } from 'react-native';

import { startBookInPlace } from '@/components/player/start-book';
import {
  fallbackAddress,
  pickAddress,
  sameAddresses,
  sameUrl,
  type ServerIdProbe,
  streamBase,
} from '@/lib/server-address';
import { ticker } from '@/lib/ticker';
import { onForeground } from '@/lib/when-active';
import { type NowPlaying, selectBookPosition, usePlayer } from '@/playback/store';
import { type Connection, useSession } from '@/stores/session';

import {
  beginNetworkCheck,
  effectiveUrl,
  endNetworkCheck,
  setAddressPick,
  useAddressRoute,
} from './address-route';
import { resolveClient } from './connection-clients';
import { addressesQuery, fetchCapabilities, fetchFailFast } from './hooks';
import { onReconnect, useReachability } from './reachability';
import { probeServerId } from './server-id-probe';

/**
 * The home/away address runner (native only; the web player keeps its own origin).
 * Framework-free, started once from the root layout like the other controllers
 * (`startAddressRouting`). It:
 * - re-picks each connection's address (`pickAddress`: probe home without a token, use
 *   it only on a matching `server_id`) at launch, when the app comes to the foreground,
 *   when the network changes (at once for a move, else once a burst of events settles,
 *   `NETWORK_SETTLE_MS`), when a connection's URL or addresses change, and at once
 *   when the reachability tracker marks a connection offline (its 20 s probe then runs
 *   through the client built on the new address), and every `HOME_RECHECK_MS` while
 *   the app is in the foreground for a connection with a home address (walking in the
 *   door raises no event the runner hears: Wi-Fi joins without a type change, and the
 *   app stays open; and an idle app on its home address sends nothing that would fail
 *   when home goes away); one probe per connection at a time, none in the background. When the device leaves its network (`movedNetwork`: another type, no
 *   connection, or `ipChanged`: another IP address of its own, one Wi-Fi to another), a
 *   home pick is dropped first (`leaveHome`), so the token never goes to a home address
 *   checked on another network;
 * - refreshes the addresses the device keeps from `GET /addresses` (servers with
 *   `addresses`) at launch, for a new connection and on reconnect;
 * - keeps the playing book playing when its connection switches address: a streamed
 *   book's track URLs are baked in at load, so when it plays (or tries to) from an
 *   address its connection no longer uses, it is started again in place, at its
 *   position and speed, through `startBookInPlace`.
 */

let probe: ServerIdProbe = probeServerId;
/** Each connection's latest re-pick: an older one still probing must not land over it. */
const generations = new Map<string, number>();
/** The connections with a re-pick in flight (the periodic re-check skips them). */
const probing = new Map<string, number>();

/** How often a connection with a home address asks home again, in the foreground: away,
 * to come home; on home, to notice it stopped answering. */
export const HOME_RECHECK_MS = 90_000;

function connectionOf(connectionId: string): Connection | undefined {
  return useSession.getState().connections.find((c) => c.id === connectionId);
}

/** Pick the address for one connection now, and apply it. */
export async function repick(connectionId: string): Promise<void> {
  const conn = connectionOf(connectionId);
  if (!conn) return;
  const generation = (generations.get(connectionId) ?? 0) + 1;
  generations.set(connectionId, generation);
  probing.set(connectionId, (probing.get(connectionId) ?? 0) + 1);
  let url: string;
  try {
    url = await pickAddress(conn, probe);
  } finally {
    const left = (probing.get(connectionId) ?? 1) - 1;
    if (left > 0) probing.set(connectionId, left);
    else probing.delete(connectionId);
  }
  if (generations.get(connectionId) !== generation) return;
  // The connection changed while the home address was being asked (removed, re-paired,
  // new addresses): that change re-picks on its own, with what is true now.
  const now = connectionOf(connectionId);
  if (!now || now.serverUrl !== conn.serverUrl || !sameAddresses(now.addresses, conn.addresses))
    return;
  setAddressPick(connectionId, sameUrl(url, now.serverUrl) ? null : url);
}

/** How long a network change that keeps the device where it is waits for the next one
 * before every connection is re-picked: Android reports capability changes as network
 * events, often in bursts, and each re-pick asks home again. A move doesn't wait. */
export const NETWORK_SETTLE_MS = 1_000;
let settling: ReturnType<typeof setTimeout> | null = null;

function repickAll(): void {
  if (settling) clearTimeout(settling);
  settling = null;
  for (const c of useSession.getState().connections) void repick(c.id);
}

/** The periodic re-check: ask home again for each connection that has a home address
 * and no re-pick in flight already. Away, that is how it comes home; ON its home address,
 * it is how it notices leaving: an idle app sends nothing else that would fail (the
 * Pixel stayed on a dead home address for 150 s), and a re-pick that finds home still
 * answering as this server changes nothing. */
function recheckHome(): void {
  for (const c of useSession.getState().connections) {
    if (!c.addresses?.home || probing.has(c.id)) continue;
    void repick(c.id);
  }
}

/**
 * The device moved to another network: a home address it checked on the previous one
 * proves nothing here (another box can sit at the same private IP), so every connection
 * using its home address goes back to its away address (else its paired URL) at once,
 * before anything else is sent, and the re-pick that follows checks home again.
 */
export function leaveHome(): void {
  for (const c of useSession.getState().connections) {
    const home = c.addresses?.home;
    if (!home || !sameUrl(effectiveUrl(c), home)) continue;
    generations.set(c.id, (generations.get(c.id) ?? 0) + 1); // a probe in flight is stale too
    const fallback = fallbackAddress(c);
    setAddressPick(c.id, sameUrl(fallback, c.serverUrl) ? null : fallback);
  }
}

/** The network type last seen, to tell a move (another type, or no connection) from a
 * change that keeps the device where it is (Android reports capability changes too). */
let lastNetworkType: Network.NetworkStateType | undefined;

/** Whether `state` means the device left the network it was on. */
export function movedNetwork(state: Network.NetworkState): boolean {
  const previous = lastNetworkType;
  lastNetworkType = state.type;
  if (state.isConnected === false) return true;
  return previous !== undefined && state.type !== undefined && state.type !== previous;
}

/** The device's own IP address last read, to tell a move between two networks of the
 * same type (one Wi-Fi to another) from a change that keeps the device where it is. */
let lastIp: string | undefined;
/** The IP reads started, and the newest one that finished (an older read that finishes
 * late says nothing new). */
let ipReadsStarted = 0;
let ipReadApplied = 0;

/** The device's own IP address, or undefined when it can't be told (the read fails, or
 * `0.0.0.0`: no address). */
async function deviceIp(): Promise<string | undefined> {
  try {
    const ip = await Network.getIpAddressAsync();
    return ip && ip !== '0.0.0.0' ? ip : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the device's IP address and whether it changed since the last one read: the
 * device moved to another network even when the type stayed the same. An unknown address
 * is no move by itself (and keeps the last one known for the next read to compare with).
 */
export async function ipChanged(): Promise<boolean> {
  const read = ++ipReadsStarted;
  const ip = await deviceIp();
  if (!ip || read < ipReadApplied) return false;
  ipReadApplied = read;
  const previous = lastIp;
  lastIp = ip;
  return previous !== undefined && previous !== ip;
}

/** Move: every home pick goes at once, then each connection is picked again. */
function moved(): void {
  leaveHome();
  repickAll();
}

/** A network event: a move (another type, no connection) drops home and re-picks at
 * once; any other change re-picks once the events settle (a newer re-pick still
 * supersedes a probe in flight, so a home address checked before the change is never
 * used after it), unless the device's IP address turns out to have changed (another
 * network of the same type, e.g. one Wi-Fi to another), which is a move too. A burst of
 * events on the same network keeps its IP, so it neither flaps nor restarts the playing
 * book. */
function onNetwork(state: Network.NetworkState): void {
  const changedIp = ipChanged(); // read now, so a move by type records the new address too
  if (movedNetwork(state)) {
    moved();
    return;
  }
  if (settling) clearTimeout(settling);
  settling = setTimeout(repickAll, NETWORK_SETTLE_MS);
  void changedIp.then((changed) => {
    if (changed) moved();
  });
}

/** Read `GET /addresses` from a server that has `addresses` and keep what it says
 * (`learnAddresses`: an answer read away from home can't know the home address). Quiet
 * on any failure: the next launch or reconnect asks again. */
export async function refreshAddresses(connectionId: string): Promise<void> {
  const client = resolveClient(connectionId);
  if (!client) return;
  try {
    const caps = await fetchCapabilities(connectionId, client);
    if (!caps.addresses) return;
    const answer = await fetchFailFast({ ...addressesQuery(connectionId, client), staleTime: 0 });
    await useSession.getState().learnAddresses(connectionId, answer);
  } catch {
    // Unreachable or refused: keep what the device knows.
  }
}

/** The playing book's last restart: not tried twice for the same book load and
 * address, so a restart that fails (the new address unreachable too) isn't retried on
 * every player tick. */
let restart: { nowPlaying: NowPlaying; url: string } | null = null;
let restarting = false;

/** The playing book's last address check, for one book load, connection list and set of
 * picks: the address it should move to, or null (downloaded, or already on the address
 * in use). Worked out again only when one of the three changes, so a player tick costs
 * three comparisons. */
let follow: {
  nowPlaying: NowPlaying;
  connections: Connection[];
  picks: Record<string, string>;
  moveTo: string | null;
} | null = null;

function addressToFollow(np: NowPlaying): string | null {
  const { connections } = useSession.getState();
  const { picks } = useAddressRoute.getState();
  if (follow?.nowPlaying === np && follow.connections === connections && follow.picks === picks)
    return follow.moveTo;
  const base = np.queue.tracks[0] ? streamBase(np.queue.tracks[0].url) : null; // null: downloaded
  const conn = base ? connections.find((c) => c.id === np.connectionId) : undefined;
  const url = conn ? effectiveUrl(conn) : null;
  const moveTo = base && url && !sameUrl(base, url) ? url : null;
  follow = { nowPlaying: np, connections, picks, moveTo };
  return moveTo;
}

/**
 * Keep the playing book on its connection's address. Only a streamed book that is
 * playing or trying to (`playing`, `loading`: a press on play, a retry, a stall) and
 * placed (not mid-load, a known position) is restarted, so a paused book never starts
 * by itself: it restarts at the listener's next press on play.
 */
export function followPlayingBook(): void {
  if (restarting) return;
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  if (!np || player.loadingBook) return;
  const { state } = player.snapshot;
  if (state !== 'playing' && state !== 'loading') return;
  const url = addressToFollow(np);
  if (!url) return;
  const position = selectBookPosition(player);
  if (!(position > 0)) return;
  if (restart?.nowPlaying === np && restart.url === url) return;
  restart = { nowPlaying: np, url };
  restarting = true;
  startBookInPlace(
    { connectionId: np.connectionId, libraryId: np.libraryId, path: np.path },
    { position, speed: player.rate },
  )
    .catch((err) => console.warn('[address] could not move the playing book', err))
    .finally(() => {
      restarting = false;
    });
}

/**
 * Start the runner; returns its teardown. A no-op on web. `opts.probe` replaces the
 * home probe (tests).
 */
export function startAddressRouting(opts: { probe?: ServerIdProbe } = {}): () => void {
  if (Platform.OS === 'web') return () => undefined;
  probe = opts.probe ?? probeServerId;
  const stops: (() => void)[] = [];

  let launched = false;
  const launch = () => {
    launched = true;
    // Refresh once the pick is in, so the read goes to an address that answers.
    for (const c of useSession.getState().connections)
      void repick(c.id).then(() => refreshAddresses(c.id));
  };
  if (useSession.getState().status !== 'loading') launch();

  stops.push(
    useSession.subscribe((s, prev) => {
      if (!launched) {
        if (s.status !== 'loading') launch();
        return;
      }
      if (s.connections === prev.connections) return;
      for (const c of s.connections) {
        const before = prev.connections.find((p) => p.id === c.id);
        if (!before) {
          void repick(c.id).then(() => refreshAddresses(c.id));
        } else if (
          before.serverUrl !== c.serverUrl ||
          !sameAddresses(before.addresses, c.addresses)
        ) {
          void repick(c.id);
        }
      }
      for (const p of prev.connections) {
        if (!s.connections.some((c) => c.id === p.id)) {
          generations.delete(p.id);
          setAddressPick(p.id, null);
        }
      }
      followPlayingBook();
    }),
  );

  // Back in the foreground: the device may have moved while JS was suspended (no network
  // events then), so the network is read first, with the same signal as a network event
  // (another type, no connection, or another IP address). What sends requests on the
  // same foreground event waits for this (`networkChecked`, due from the moment the app
  // left), so a home pick from the previous network is dropped before the token goes out.
  const readNetwork = async () => {
    try {
      const [state, changedIp] = await Promise.all([
        Network.getNetworkStateAsync().catch(() => undefined),
        ipChanged(),
      ]);
      if ((state && movedNetwork(state)) || changedIp) leaveHome();
      repickAll();
    } finally {
      endNetworkCheck();
    }
  };
  // The re-check of home runs only in the foreground.
  const recheck = ticker(recheckHome, HOME_RECHECK_MS);
  if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive')
    recheck.start();
  else beginNetworkCheck(); // started away (a background launch): check on coming to front
  stops.push(
    onForeground(
      () => {
        recheck.start();
        void readNetwork();
      },
      () => {
        recheck.stop();
        beginNetworkCheck();
      },
    ),
  );
  stops.push(() => recheck.stop());
  stops.push(endNetworkCheck);

  // Network changes (native only; the runner never runs on web). Seeded with the current
  // type and IP address so the first change can be told from a move.
  lastNetworkType = undefined;
  lastIp = undefined;
  void Network.getNetworkStateAsync().then(
    (state) => {
      lastNetworkType ??= state.type;
    },
    () => undefined,
  );
  void ipChanged();
  try {
    const netSub = Network.addNetworkStateListener(onNetwork);
    stops.push(() => netSub.remove());
  } catch {
    // No network events on this platform: launch, foreground and reachability still
    // re-pick.
  }

  stops.push(
    useReachability.subscribe((s, prev) => {
      for (const [cid, online] of Object.entries(s.online)) {
        if (online === false && prev.online[cid] !== false) void repick(cid);
      }
    }),
  );

  stops.push(onReconnect((cid) => void refreshAddresses(cid)));

  stops.push(usePlayer.subscribe(followPlayingBook));
  stops.push(useAddressRoute.subscribe(followPlayingBook));

  return () => {
    for (const stop of stops) stop();
    probe = probeServerId;
    restart = null;
    follow = null;
    if (settling) clearTimeout(settling);
    settling = null;
    probing.clear();
  };
}
