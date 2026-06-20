import { NativeModule, requireNativeModule } from 'expo';

import type {
  AudiosiloPlayerModuleEvents,
  NativeTrack,
  PlayerConfig,
} from './AudiosiloPlayer.types';

declare class AudiosiloPlayerModule extends NativeModule<AudiosiloPlayerModuleEvents> {
  /** Initialise the audio session / media session (idempotent). */
  setup(): Promise<void>;
  /** Update runtime tunables (rewind, lock-screen skip intervals). */
  setConfig(config: PlayerConfig): Promise<void>;
  /** Load a queue and position to `startIndex` at `positionInTrack` seconds (does not auto-play). */
  load(tracks: NativeTrack[], startIndex: number, positionInTrack: number): Promise<void>;
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
}

export default requireNativeModule<AudiosiloPlayerModule>('AudiosiloPlayer');
