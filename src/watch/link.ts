import { NO_WATCH, type WatchLink } from './watch-model';

/** No watch link here (web, Android). Wear OS comes in behind the same surface (W4). The iOS
 * one is `link.ios.ts`. */
export const watchLink: WatchLink = {
  supported: false,
  read: async () => NO_WATCH,
  subscribe: () => () => {},
  sendPair: async () => {},
  sendBook: async () => {},
};
