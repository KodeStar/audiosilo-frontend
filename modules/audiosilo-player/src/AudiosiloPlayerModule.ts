import { NativeModule, requireNativeModule } from 'expo';

import type {
  AudiosiloPlayerModuleEvents,
  BookRef,
  LoadedBook,
  NativeChapter,
  NativeTrack,
  PendingBookmark,
  PlayerConfig,
} from './AudiosiloPlayer.types';

declare class AudiosiloPlayerModule extends NativeModule<AudiosiloPlayerModuleEvents> {
  /** Initialise the audio session / media session (idempotent). */
  setup(): Promise<void>;
  /** Update runtime tunables (rewind, lock-screen skip intervals, the audio effects). */
  setConfig(config: PlayerConfig): Promise<void>;
  /** Load a queue and position to `startIndex` at `positionInTrack` seconds (does not
   * auto-play). `chapters` gives the lock screen a chapter scrubber + prev/next chapter
   * (Android makes each a clipped media item; iOS maps the file place onto them); omit/empty
   * for file-per-item. `book` names the book: Android's `getLoadedBook`, and on iOS
   * CarPlay's playing indicator. A binary that predates it throws on a 5th argument, so
   * `service.native.ts` passes it only when `getLoadedBook` exists (the two ship together). */
  load(
    tracks: NativeTrack[],
    startIndex: number,
    positionInTrack: number,
    chapters?: NativeChapter[],
    book?: BookRef,
  ): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  /** Seek within the current track (seconds). */
  seekTo(seconds: number): Promise<void>;
  /** Jump to a queue index, optionally at a position (seconds). */
  skipToTrack(index: number, seconds: number): Promise<void>;
  /** Set playback speed (pitch-corrected). */
  setRate(rate: number): Promise<void>;
  /** Set the engine's own output volume, 0..1 linear gain (NOT the device volume) - the
   * sleep timer's fade-out. The value is sticky: it survives a queue rebuild and is only
   * changed by another call, so whoever faded down owns restoring it.
   * **Added after the first shipped builds**, so an installed older binary won't define it
   * and calling it there throws - `service.native.ts` feature-detects before calling. */
  setVolume(volume: number): Promise<void>;
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
  /** Both platforms: hand native the car snapshot (JSON) for CarPlay / Android Auto. Native
   * keeps the last one on disk so the car shows it at once next time. Absent on older binaries. */
  setCarSnapshot?(json: string): Promise<void>;
  /** Android: the book the service has loaded, else null (iOS: always null). Absent on
   * older binaries. */
  getLoadedBook?(): Promise<LoadedBook | null>;
  /** Android: bookmarks pressed while no JS ran, oldest first, cleared by the read (iOS:
   * []). Absent on older binaries. */
  consumePendingBookmarks?(): Promise<PendingBookmark[]>;
}

export default requireNativeModule<AudiosiloPlayerModule>('AudiosiloPlayer');
