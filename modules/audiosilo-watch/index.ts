import { type NativeModule, requireOptionalNativeModule } from 'expo';

/** What the native side knows of the watch (`getSnapshot`, the `watchState` event). `state` is
 * absent until the watch has sent one. */
export type NativeWatchSnapshot = { paired: boolean; installed: boolean; state?: unknown };

type Events = { watchState: (snapshot: NativeWatchSnapshot) => void };

declare class AudiosiloWatchModule extends NativeModule<Events> {
  isSupported(): boolean;
  /** Waits for the session to activate (5 s at most). */
  getSnapshot(): Promise<NativeWatchSnapshot>;
  /** Rejects when no watch has the app installed. When it answers, a `sendBook` is behind it. */
  sendPair(message: Record<string, unknown>): Promise<void>;
  sendBook(message: Record<string, unknown>): Promise<void>;
}

/** Null on a binary built without the module: the JS bundle can be newer than the app. */
export default requireOptionalNativeModule<AudiosiloWatchModule>('AudiosiloWatch');
