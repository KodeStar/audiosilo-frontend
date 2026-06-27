/** One audio file in the playback queue. Mirrors the app's `PlaybackTrack`. */
export type NativeTrack = {
  id: string;
  url: string;
  /** Auth headers (e.g. Authorization). Used for both the stream and artwork. */
  headers?: Record<string, string>;
  title: string;
  album?: string;
  artist?: string;
  artwork?: string;
  /** Track duration in seconds, if known. */
  duration?: number;
};

/** A chapter clip for the Android engine to turn into a clipped MediaItem (lock-screen
 * chapter scrubber + prev/next chapter). `fileIndex` indexes into the `tracks` passed to
 * `load`; `startInFile`/`endInFile` bound the clip within that file (`endInFile <= 0` ⇒ to
 * end of file). Optional `load` arg — iOS ignores it. */
export type NativeChapter = {
  fileIndex: number;
  startInFile: number;
  endInFile: number;
  title: string;
};

export type NativeState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';

export type StateEvent = { state: NativeState };
/** Position/duration within the current track, in seconds. */
export type ProgressEvent = { position: number; duration: number };
export type TrackChangeEvent = { index: number };

/** Tunables that can change at runtime (driven by the app's settings store). */
export type PlayerConfig = {
  /** Max seconds to rewind when resuming after a pause (0 = disabled). */
  autoRewindMax: number;
  /** Lock-screen skip-forward interval (seconds). */
  jumpForward: number;
  /** Lock-screen skip-backward interval (seconds). */
  jumpBackward: number;
};

export type AudiosiloPlayerModuleEvents = {
  onState: (event: StateEvent) => void;
  onProgress: (event: ProgressEvent) => void;
  onTrackChange: (event: TrackChangeEvent) => void;
};
