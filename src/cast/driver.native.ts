import { NativeModules, Platform } from 'react-native';
import GoogleCast, {
  type CastSession,
  type MediaLoadRequest,
  type MediaStatus,
  PlayServicesState,
  RemoteMediaClient,
} from 'react-native-google-cast';

import { fromSdkStatus, nativeLoadRequest, type SdkStatus, withLivePosition } from './sdk-shapes';
import type { CastDriver, CastMediaStatus, CastRemote, CastSessionEvent } from './types';

/** A status read gets this long (ms): the Android SDK's getters can hang (react-native-google-
 * cast #577), and a final read must never hold up handing the book back. */
const READ_TIMEOUT_MS = 1_500;

/** Does this binary have the Cast module? The JS bundle can be newer than the installed binary
 * (a store build that predates casting): then there is no `RNGCCastContext`, and every call
 * into the library would throw, so nothing here touches it. */
function moduleInBinary(): boolean {
  return NativeModules.RNGCCastContext != null && NativeModules.RNGCRemoteMediaClient != null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** One connected session's controls over react-native-google-cast's `RemoteMediaClient`.
 * Status comes from its events (`onMediaStatusUpdated`, `onMediaProgressUpdated`), which the
 * library's docs prefer over its getters on Android. */
function remoteOf(client: RemoteMediaClient): CastRemote {
  return {
    load: (request) => client.loadMedia(nativeLoadRequest(request) as MediaLoadRequest),
    play: () => client.play(),
    pause: () => client.pause(),
    seek: (position) => client.seek({ position }),
    setRate: (rate) => client.setPlaybackRate(rate),
    stop: () => client.stop(),
    // The status' own position is where the receiver was at its last status message (it
    // sends none while it simply plays): the place read here, which the session's last read
    // saves and hands back to the phone, takes the SDK's live estimate (`withLivePosition`).
    readStatus: async (): Promise<CastMediaStatus | null> => {
      const [s, live] = await Promise.all([
        withTimeout(client.getMediaStatus(), READ_TIMEOUT_MS),
        withTimeout(client.getStreamPosition(), READ_TIMEOUT_MS),
      ]);
      return withLivePosition(fromSdkStatus(s as SdkStatus | null), live);
    },
    onStatus: (handler) => {
      const sub = client.onMediaStatusUpdated((s: MediaStatus | null) =>
        handler(fromSdkStatus(s as SdkStatus | null)),
      );
      return () => sub.remove();
    },
    onProgress: (handler) => {
      const sub = client.onMediaProgressUpdated((progress) => {
        if (typeof progress === 'number' && Number.isFinite(progress)) handler(progress);
      }, 1);
      // The library starts its iOS progress timer only when a media status arrives, and a
      // session resumed after a relaunch got its status before anything listened (and a
      // receiver that simply plays sends no more): ask for one, so the ticks start now.
      void client.requestStatus().catch(() => undefined);
      return () => sub.remove();
    },
  };
}

async function deviceNameOf(session: CastSession): Promise<string | undefined> {
  const device = await withTimeout(session.getCastDevice(), READ_TIMEOUT_MS);
  return device?.friendlyName || undefined;
}

/** The library keeps one `RemoteMediaClient` per session object; the app keeps one for all,
 * so a progress listener is never registered twice. */
let sharedClient: RemoteMediaClient | null = null;
function client(): RemoteMediaClient {
  sharedClient ??= new RemoteMediaClient();
  return sharedClient;
}

/**
 * The native Cast driver (react-native-google-cast 4.9.1, the Google Cast SDKs for iOS and
 * Android, the Default Media Receiver). Discovery, the device chooser and the session are the
 * SDK's (its `CastButton`); this reports the session's life and drives its media.
 */
export const castDriver: CastDriver = {
  async supported() {
    if (!moduleInBinary()) return false;
    if (Platform.OS !== 'android') return true;
    // A device without Google Play services (or with a broken one) can't cast; the library
    // already guards its own init there, so this only hides the button.
    const state = await withTimeout(GoogleCast.getPlayServicesState(), READ_TIMEOUT_MS);
    return state === PlayServicesState.SUCCESS;
  },

  async init() {
    return moduleInBinary();
  },

  subscribe(handler: (event: CastSessionEvent) => void) {
    if (!moduleInBinary()) return () => {};
    const sm = GoogleCast.getSessionManager();
    const connected = (type: 'started' | 'resumed') => (session: CastSession) => {
      void deviceNameOf(session).then((deviceName) =>
        handler({ type, remote: remoteOf(client()), deviceName }),
      );
    };
    const subs = [
      sm.onSessionStarting(() => handler({ type: 'starting' })),
      sm.onSessionStarted(connected('started')),
      sm.onSessionResumed(connected('resumed')),
      sm.onSessionStartFailed((_s, error) => handler({ type: 'startFailed', error })),
      sm.onSessionSuspended(() => handler({ type: 'suspended' })),
      sm.onSessionEnding(() => handler({ type: 'ending' })),
      sm.onSessionEnded((_s, error) => handler({ type: 'ended', error })),
    ];
    return () => {
      for (const s of subs) s.remove();
    };
  },

  async current() {
    if (!moduleInBinary()) return null;
    const session = await withTimeout(
      GoogleCast.getSessionManager().getCurrentCastSession(),
      READ_TIMEOUT_MS,
    );
    if (!session) return null;
    return { remote: remoteOf(client()), deviceName: await deviceNameOf(session) };
  },

  async endSession(stopCasting) {
    if (!moduleInBinary()) return;
    await GoogleCast.getSessionManager()
      .endCurrentSession(stopCasting)
      .catch(() => undefined);
  },
};
