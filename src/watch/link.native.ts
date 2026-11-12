import { Platform } from 'react-native';

import AudiosiloWatch, { type NativeWatchSnapshot } from '../../modules/audiosilo-watch';

import {
  NO_WATCH_LINK,
  parseTransfers,
  parseWatchState,
  watchKindOf,
  type WatchLink,
  type WatchStatus,
} from './watch-model';

const statusOf = (snapshot: NativeWatchSnapshot): WatchStatus => ({
  paired: snapshot.paired,
  installed: snapshot.installed,
  state: parseWatchState(snapshot.state),
  watchId: snapshot.watch_id ?? null,
  transfers: parseTransfers(snapshot.outstanding),
});

const native = AudiosiloWatch?.isSupported() ? AudiosiloWatch : null;

/** The phone's watch, through `modules/audiosilo-watch`: an Apple Watch over WatchConnectivity on
 * iOS, a Wear OS watch over the Wear Data Layer on Android (none without Play services). The
 * snapshot reads the same on both. */
export const watchLink: WatchLink = native
  ? {
      supported: true,
      kind: watchKindOf(Platform.OS),
      read: async () => statusOf(await native.getSnapshot()),
      subscribe: (listener) => {
        native.addListener('watchState', (snapshot) => listener(statusOf(snapshot)));
      },
      sendPair: (message) => native.sendPair(message),
      sendBook: (message) => native.sendBook(message),
      sendRemove: (message) => native.sendRemove(message),
      ...(native.openInstallOnWatch
        ? { openInstallOnWatch: async () => native.openInstallOnWatch?.() }
        : {}),
    }
  : // No module in this build, or no Play services: still the platform's watch, for any wording.
    { ...NO_WATCH_LINK, kind: watchKindOf(Platform.OS) };
