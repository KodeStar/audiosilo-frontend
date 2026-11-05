import AudiosiloWatch, { type NativeWatchSnapshot } from '../../modules/audiosilo-watch';

import { NO_WATCH, parseWatchState, type WatchLink, type WatchStatus } from './watch-model';

const statusOf = ({ paired, installed, state }: NativeWatchSnapshot): WatchStatus => ({
  paired,
  installed,
  state: parseWatchState(state),
});

/** Apple Watch, through `modules/audiosilo-watch` (WatchConnectivity). */
export const watchLink: WatchLink = {
  supported: AudiosiloWatch?.isSupported() === true,
  read: async () => {
    if (!AudiosiloWatch) return NO_WATCH;
    const [paired, installed, state] = await Promise.all([
      AudiosiloWatch.isPaired(),
      AudiosiloWatch.isWatchAppInstalled(),
      AudiosiloWatch.getWatchState(),
    ]);
    return statusOf({ paired, installed, state });
  },
  subscribe: (listener) => {
    const subscription = AudiosiloWatch?.addListener('watchState', (snapshot) =>
      listener(statusOf(snapshot)),
    );
    return () => subscription?.remove();
  },
  sendPair: async (message) => {
    await AudiosiloWatch?.sendPair(message);
  },
  sendBook: async (message) => {
    await AudiosiloWatch?.sendBook(message);
  },
};
