import type {
  LoadedBook,
  PendingBookmark,
} from '../../modules/audiosilo-player/src/AudiosiloPlayer.types';

/**
 * The car functions and events of the native player module (CarPlay, Android Auto), behind
 * ONE seam that feature-detects them: the JS bundle can be newer than the installed binary (a
 * shipped App Store / Play build), and calling a function a native module doesn't define
 * throws. Everything degrades to nothing there: `available` is false, the reads answer null
 * or [], and the listeners never fire.
 *
 * This file is the web (and type-resolution) side: no car, ever. Metro picks
 * `car-native.native.ts` on iOS and Android.
 */
export type CarNative = {
  /** The binary has the car functions (`setCarSnapshot`). */
  available: boolean;
  /** Hand native the car snapshot (JSON). Resolves false when it could not. */
  setSnapshot: (json: string) => Promise<boolean>;
  /** Android: the book the playback service has loaded, else null (iOS: always null). */
  getLoadedBook: () => Promise<LoadedBook | null>;
  /** Android: bookmarks pressed while no JS ran, oldest first, cleared by the read. */
  consumePendingBookmarks: () => Promise<PendingBookmark[]>;
  /** CarPlay or Android Auto connected (true) or left (false). Returns the unsubscribe. */
  onConnection: (handler: (connected: boolean) => void) => () => void;
  /** The car asked to play a book (its car item id) that native can't start alone. */
  onPlayRequest: (handler: (id: string) => void) => () => void;
  /** A bookmark button outside the app was pressed (CarPlay's Now Playing button, the
   * Android notification / Android Auto) while JS runs: the engine's place at the press
   * (file index + seconds in that file) of the book it has loaded. */
  onBookmark: (handler: (trackIndex: number, positionInTrack: number) => void) => () => void;
};

const none = () => () => undefined;

export const carNative: CarNative = {
  available: false,
  setSnapshot: async () => false,
  getLoadedBook: async () => null,
  consumePendingBookmarks: async () => [],
  onConnection: none,
  onPlayRequest: none,
  onBookmark: none,
};
