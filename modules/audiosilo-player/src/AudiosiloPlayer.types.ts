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

/** A chapter clip for the lock screen's chapter scrubber + prev/next chapter (Android turns
 * each into a clipped MediaItem; iOS maps the file place onto them). `fileIndex` indexes into
 * the `tracks` passed to `load`; `startInFile`/`endInFile` bound the clip within that file
 * (`endInFile <= 0` ⇒ to end of file). Optional `load` arg. */
export type NativeChapter = {
  fileIndex: number;
  startInFile: number;
  endInFile: number;
  title: string;
};

export type NativeState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';

export type StateEvent = { state: NativeState };
/** Position/duration within the current track, in seconds. `silenceSaved` (Android only):
 * book seconds removed by Smart Speed since the engine was created, monotonic while the engine
 * lives (a new engine starts again at 0). Absent on iOS and on binaries older than Phase 6. */
export type ProgressEvent = { position: number; duration: number; silenceSaved?: number };
export type TrackChangeEvent = { index: number };

/** The engine moved because of something OUTSIDE the JS API (the lock screen or notification
 * scrubber and buttons, a headset, CarPlay, Android Auto, their chapter lists), sent once the move
 * landed, in the bridge's usual coordinates (FILE index + seconds within that file). Not sent for
 * moves the JS API asked for, auto-rewind on play, Smart Speed's silence skips, or a file
 * advancing by itself at its end. */
export type RemoteMoveEvent = { trackIndex: number; position: number };

/** The OS changed the speed (CarPlay's rate button, iOS changePlaybackRateCommand, an Android
 * controller). The engine already applied it. */
export type RateChangeEvent = { rate: number };

/** A bookmark button outside the app was pressed (CarPlay, the Android notification / Android
 * Auto custom action): where the book was at the press. */
export type RemoteBookmarkEvent = { trackIndex: number; position: number };

/** CarPlay or Android Auto connected or disconnected. */
export type CarConnectionEvent = { connected: boolean };

/** The car asked to play a book native can't start alone; JS starts it (`startBookInPlace`). */
export type CarPlayRequestEvent = { id: string };

/** A book's identity: path is the identity, scoped by connection (never a DB id). */
export type BookRef = { connectionId: string; libraryId: number; path: string };

/** Android: the book the SERVICE has loaded (started from the car, or still playing when the
 * app's JS restarted). */
export type LoadedBook = BookRef & {
  trackIndex: number;
  position: number;
  rate: number;
  playing: boolean;
};

/** Android: a bookmark pressed while no JS was running. */
export type PendingBookmark = BookRef & { trackIndex: number; position: number };

/** Tunables that can change at runtime (driven by the app's settings store). */
export type PlayerConfig = {
  /** Max seconds to rewind when resuming after a pause (0 = disabled). */
  autoRewindMax: number;
  /** Lock-screen skip-forward interval (seconds). */
  jumpForward: number;
  /** Lock-screen skip-backward interval (seconds). */
  jumpBackward: number;
  /** Trim silences (Android only; iOS accepts and ignores it). Default false. Ignored by
   * binaries older than Phase 6. */
  smartSpeed?: boolean;
  /** Compress and lift speech. Default false. Ignored by binaries older than Phase 6. */
  voiceBoost?: boolean;
};

export type AudiosiloPlayerModuleEvents = {
  onState: (event: StateEvent) => void;
  onProgress: (event: ProgressEvent) => void;
  onTrackChange: (event: TrackChangeEvent) => void;
  onRemoteMove: (event: RemoteMoveEvent) => void;
  onRateChange: (event: RateChangeEvent) => void;
  onRemoteBookmark: (event: RemoteBookmarkEvent) => void;
  onCarConnection: (event: CarConnectionEvent) => void;
  onCarPlayRequest: (event: CarPlayRequestEvent) => void;
};
