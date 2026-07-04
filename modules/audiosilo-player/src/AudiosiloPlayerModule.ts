import { NativeModule, requireNativeModule } from 'expo';

import type {
  AudiosiloPlayerModuleEvents,
  NativeChapter,
  NativeTrack,
  PlayerConfig,
} from './AudiosiloPlayer.types';

declare class AudiosiloPlayerModule extends NativeModule<AudiosiloPlayerModuleEvents> {
  /** Initialise the audio session / media session (idempotent). */
  setup(): Promise<void>;
  /** Update runtime tunables (rewind, lock-screen skip intervals). */
  setConfig(config: PlayerConfig): Promise<void>;
  /** Load a queue and position to `startIndex` at `positionInTrack` seconds (does not
   * auto-play). `chapters` (Android only) makes each chapter a clipped media item so the
   * lock screen gets a chapter scrubber + prev/next chapter; omit/empty for file-per-item. */
  load(
    tracks: NativeTrack[],
    startIndex: number,
    positionInTrack: number,
    chapters?: NativeChapter[],
  ): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  /** Seek within the current track (seconds). */
  seekTo(seconds: number): Promise<void>;
  /** Jump to a queue index, optionally at a position (seconds). */
  skipToTrack(index: number, seconds: number): Promise<void>;
  /** Set playback speed (pitch-corrected). */
  setRate(rate: number): Promise<void>;
  /** Stop playback and clear the queue. */
  reset(): Promise<void>;
  /** Present the OS audio-route picker so the user can send playback elsewhere: the
   * AirPlay route sheet on iOS (→ HomePod, AirPlay speakers), the media-output switcher
   * on Android (→ Bluetooth e.g. an Echo, Cast devices). Resolves true if one was shown. */
  showRoutePicker(): Promise<boolean>;
  /** Android: returns true (once, then clears) if the app was swiped away from
   * recents since the last call - the JS layer uses it to reset to Home on the next
   * foreground (Android keeps the dismissed process cached, so the next open is a
   * warm resume on the last route). iOS cold-starts on relaunch, so it's always false. */
  consumeTaskRemoved(): boolean;
}

export default requireNativeModule<AudiosiloPlayerModule>('AudiosiloPlayer');
