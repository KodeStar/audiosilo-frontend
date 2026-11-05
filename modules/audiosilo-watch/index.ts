import { type NativeModule, requireOptionalNativeModule } from 'expo';

/** The native side's `watchState` event: the same as asking `isPaired`,
 * `isWatchAppInstalled` and `getWatchState` together. `state` is absent until the watch has
 * sent one. */
export type NativeWatchSnapshot = { paired: boolean; installed: boolean; state?: unknown };

type Events = { watchState: (snapshot: NativeWatchSnapshot) => void };

declare class AudiosiloWatchModule extends NativeModule<Events> {
  isSupported(): boolean;
  /** These three wait for the session to activate (5 s at most). */
  isPaired(): Promise<boolean>;
  isWatchAppInstalled(): Promise<boolean>;
  getWatchState(): Promise<unknown>;
  /** Rejects when no watch has the app installed. When it answers, a `sendBook` is behind it. */
  sendPair(message: Record<string, unknown>): Promise<'message' | 'transfer'>;
  sendBook(message: Record<string, unknown>): Promise<void>;
}

/** Null on a binary built without the module: the JS bundle can be newer than the app. */
export default requireOptionalNativeModule<AudiosiloWatchModule>('AudiosiloWatch');
