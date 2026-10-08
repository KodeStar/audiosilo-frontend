import * as Network from 'expo-network';
import { AppState, type AppStateStatus, Platform } from 'react-native';

import { startBookInPlace } from '@/components/player/start-book';
import { cleanAddresses } from '@/lib/pairing';
import {
  fallbackAddress,
  mergeAddresses,
  pickAddress,
  sameAddresses,
  sameUrl,
  type ServerIdProbe,
  streamBase,
} from '@/lib/server-address';
import { type NowPlaying, selectBookPosition, usePlayer } from '@/playback/store';
import { type Connection, useSession } from '@/stores/session';

import { effectiveUrl, setAddressPick, useAddressRoute } from './address-route';
import { ApiClient } from './client';
import { resolveClient } from './connection-clients';
import { addressesQuery, fetchCapabilities, fetchFailFast } from './hooks';
import { onReconnect, useReachability } from './reachability';

/**
 * The home/away address runner (native only; the web player keeps its own origin).
 * Framework-free, started once from the root layout like the other controllers
 * (`startAddressRouting`). It:
 * - re-picks each connection's address (`pickAddress`: probe home without a token, use
 *   it only on a matching `server_id`) at launch, when the app comes to the foreground,
 *   when the network changes, when a connection's URL or addresses change, and at once
 *   when the reachability tracker marks a connection offline (its 20 s probe then runs
 *   through the client built on the new address). When the device leaves its network
 *   (`movedNetwork`), a home pick is dropped first (`leaveHome`), so the token never
 *   goes to a home address checked on another network;
 * - refreshes the addresses the device keeps from `GET /addresses` (servers with
 *   `addresses`) at launch, for a new connection and on reconnect;
 * - keeps the playing book playing when its connection switches address: a streamed
 *   book's track URLs are baked in at load, so when it plays (or tries to) from an
 *   address its connection no longer uses, it is started again in place, at its
 *   position and speed, through `startBookInPlace` (no playback internals changed).
 */

/** How long the home address gets to answer before the player uses the away one. */
export const PROBE_TIMEOUT_MS = 2_500;

/** Ask `url` who it is: `GET <url>/api/v1/server` with NO token (a bare client: no
 * Authorization header, no reconnect callback). The `server_id` it answered, or null. */
export const probeServerId: ServerIdProbe = async (url) => {
  try {
    const info = await new ApiClient(url, null, PROBE_TIMEOUT_MS).serverInfo();
    return typeof info?.server_id === 'string' ? info.server_id : null;
  } catch {
    return null;
  }
};

let probe: ServerIdProbe = probeServerId;
/** Each connection's latest re-pick: an older one still probing must not land over it. */
const generations = new Map<string, number>();

function connectionOf(connectionId: string): Connection | undefined {
  return useSession.getState().connections.find((c) => c.id === connectionId);
}

/** Pick the address for one connection now, and apply it. */
export async function repick(connectionId: string): Promise<void> {
  const conn = connectionOf(connectionId);
  if (!conn) return;
  const generation = (generations.get(connectionId) ?? 0) + 1;
  generations.set(connectionId, generation);
  const url = await pickAddress(conn, probe);
  if (generations.get(connectionId) !== generation) return;
  // The connection changed while the home address was being asked (removed, re-paired,
  // new addresses): that change re-picks on its own, with what is true now.
  const now = connectionOf(connectionId);
  if (!now || now.serverUrl !== conn.serverUrl || !sameAddresses(now.addresses, conn.addresses))
    return;
  setAddressPick(connectionId, sameUrl(url, now.serverUrl) ? null : url);
}

function repickAll(): void {
  for (const c of useSession.getState().connections) void repick(c.id);
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

function onNetwork(state: Network.NetworkState): void {
  if (movedNetwork(state)) leaveHome();
  repickAll();
}

/** Read `GET /addresses` from a server that has `addresses` and keep what it says
 * (merged: an answer read away from home can't know the home address). Quiet on any
 * failure: the next launch or reconnect asks again. */
export async function refreshAddresses(connectionId: string): Promise<void> {
  const client = resolveClient(connectionId);
  if (!client) return;
  try {
    const caps = await fetchCapabilities(connectionId, client);
    if (!caps.addresses) return;
    const answer = await fetchFailFast({
      ...addressesQuery(connectionId, client, true),
      staleTime: 0,
    });
    const conn = connectionOf(connectionId);
    if (!conn) return;
    const next = mergeAddresses(conn.addresses, cleanAddresses(answer) ?? {});
    await useSession.getState().setConnectionAddresses(connectionId, next);
  } catch {
    // Unreachable or refused: keep what the device knows.
  }
}

/** The playing book's last restart: not tried twice for the same book load and
 * address, so a restart that fails (the new address unreachable too) isn't retried on
 * every player tick. */
let restart: { nowPlaying: NowPlaying; url: string } | null = null;
let restarting = false;

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
  const base = np.queue.tracks[0] ? streamBase(np.queue.tracks[0].url) : null;
  if (!base) return; // downloaded: plays from the device
  const conn = connectionOf(np.connectionId);
  if (!conn) return;
  const url = effectiveUrl(conn);
  if (sameUrl(base, url)) return;
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
  // events then), so the network is read first. The foreground refresh
  // (`useAppResume`) does not wait for it: a suspended move to a network with a box at
  // the same home IP is the one window left open.
  const readNetwork = () =>
    Network.getNetworkStateAsync().then(onNetwork, () => {
      repickAll();
    });
  let appState: AppStateStatus = AppState.currentState;
  const appSub = AppState.addEventListener('change', (next) => {
    const wasAway = appState !== 'active';
    appState = next;
    if (next === 'active' && wasAway) void readNetwork();
  });
  stops.push(() => appSub.remove());

  // Network changes (native only; the runner never runs on web). Seeded with the current
  // type so the first change can be told from a move.
  lastNetworkType = undefined;
  void Network.getNetworkStateAsync().then(
    (state) => {
      lastNetworkType ??= state.type;
    },
    () => undefined,
  );
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
  };
}
