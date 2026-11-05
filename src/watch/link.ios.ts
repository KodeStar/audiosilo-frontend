import AudiosiloWatch, { type NativeWatchSnapshot } from '../../modules/audiosilo-watch';

import {
  NO_WATCH_LINK,
  parseTransfers,
  parseWatchState,
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

/** Apple Watch, through `modules/audiosilo-watch` (WatchConnectivity). */
export const watchLink: WatchLink = native
  ? {
      supported: true,
      read: async () => statusOf(await native.getSnapshot()),
      subscribe: (listener) => {
        native.addListener('watchState', (snapshot) => listener(statusOf(snapshot)));
      },
      sendPair: (message) => native.sendPair(message),
      sendBook: (message) => native.sendBook(message),
      sendRemove: (message) => native.sendRemove(message),
    }
  : NO_WATCH_LINK;
