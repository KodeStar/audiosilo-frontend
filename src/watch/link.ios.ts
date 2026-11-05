import AudiosiloWatch, { type NativeWatchSnapshot } from '../../modules/audiosilo-watch';

import { NO_WATCH_LINK, parseWatchState, type WatchLink, type WatchStatus } from './watch-model';

const statusOf = ({ paired, installed, state }: NativeWatchSnapshot): WatchStatus => ({
  paired,
  installed,
  state: parseWatchState(state),
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
    }
  : NO_WATCH_LINK;
