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

/** What every engine report (`onState`, `onProgress`, `onTrackChange`, `onRemoteMove`,
 * `onRateChange`) carries to name the book it is of: `book`, the loaded queue's (the `book`
 * `load` was given, or the one the Android service loaded itself), so JS drops a report of a
 * book it does not hold. Absent from binaries that predate it and for a queue loaded without
 * a book (JS then takes the report as before). */
export type BookReport = { book?: BookRef };

/** `playWhenReady` (Android only): whether the engine wants to play, so the app hears of a
 * play asked from outside it (the car, a headset). Absent on iOS and on older binaries. */
export type StateEvent = { state: NativeState; playWhenReady?: boolean } & BookReport;
/** Position/duration within the current track, in seconds. `silenceSaved` (Android only):
 * book seconds removed by Smart speed since the app's process started, summed over every
 * player the service builds, so it never goes down. Absent on iOS (no Smart speed there) and on
 * binaries that predate Smart speed. `trackIndex`: the FILE the place is in, as the engine has it
 * as it sends the tick (Android tells a new file's tick before its `onTrackChange`, so without it
 * the place and the new file's length read as the old file's). */
export type ProgressEvent = {
  position: number;
  duration: number;
  silenceSaved?: number;
  trackIndex?: number;
} & BookReport;
export type TrackChangeEvent = { index: number } & BookReport;

/** The engine moved because of something OUTSIDE the JS API (the lock screen or notification
 * scrubber and buttons, a headset, CarPlay, Android Auto, their chapter lists), sent once the move
 * landed, in the bridge's usual coordinates (FILE index + seconds within that file). Not sent for
 * moves the JS API asked for, auto-rewind on play, Smart speed's silence skips, or a file
 * advancing by itself at its end. */
export type RemoteMoveEvent = { trackIndex: number; position: number } & BookReport;

/** The OS changed the speed (CarPlay's rate button, iOS changePlaybackRateCommand, an Android
 * controller). The engine already applied it. */
export type RateChangeEvent = { rate: number } & BookReport;

/** A bookmark button outside the app was pressed (CarPlay's Now Playing, Android Auto's custom
 * action; the phone's notification leaves it out): where the book was at the press, and which
 * book the engine had loaded (absent from a binary that predates it, or an engine loaded
 * without a `book`). */
export type RemoteBookmarkEvent = { trackIndex: number; position: number } & Partial<BookRef> &
  FileOfPress;

/** The file a bookmark was pressed in, by its library-relative path (`rel_path`, as in the
 * media ids), so JS finds it in whatever order the book's files are in when it reads the
 * press (fe#185); `position` is the seconds in that file. Absent from binaries that predate
 * it (and on Android when the item's id has another shape): the index alone counts then. */
export type FileOfPress = { relPath?: string };

/** CarPlay or Android Auto connected or disconnected. */
export type CarConnectionEvent = { connected: boolean };

/** The car asked to play a book native can't start alone; JS starts it (`startBookInPlace`). */
export type CarPlayRequestEvent = { id: string };

/** Android: a car play JS received is over without its load (the service's 10 s wait ran
 * out, or another play took its place). Never sent by iOS or an older binary. `replaced`:
 * another play took its place (the car's tap on another book, or on the loaded book, which
 * plays on), so a start of it loads nothing (fe#350); absent from a binary before it. */
export type CarPlayCancelEvent = { id: string; replaced?: boolean };

/** A book's identity: path is the identity, scoped by connection (never a DB id). */
export type BookRef = { connectionId: string; libraryId: number; path: string };

/** Android: the book the SERVICE has loaded (started from the car, or still playing when the
 * app's JS restarted). */
export type LoadedBook = BookRef & {
  trackIndex: number;
  position: number;
  rate: number;
  playing: boolean;
  /** The library-relative paths (`rel_path`, as in the media ids) of the files the service
   * has loaded, in its file order:
   * `trackIndex` counts in it (fe#134). Absent when the service could not tell (a queue whose
   * ids it cannot read) and on iOS, and from binaries that predate it. */
  files?: string[];
};

/** Android: a bookmark pressed while no JS was running. */
export type PendingBookmark = BookRef & { trackIndex: number; position: number } & FileOfPress;

/** Tunables that can change at runtime (driven by the app's settings store). */
export type PlayerConfig = {
  /** Max seconds to rewind when resuming after a pause (0 = disabled). */
  autoRewindMax: number;
  /** Lock-screen skip-forward interval (seconds). */
  jumpForward: number;
  /** Lock-screen skip-backward interval (seconds). */
  jumpBackward: number;
  /** Trim silences (Android only; iOS accepts and ignores it). Default false. Ignored by
   * binaries that predate the audio effects. */
  smartSpeed?: boolean;
  /** Compress and lift speech. Default false. Ignored by binaries that predate the audio
   * effects. */
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
  onCarPlayCancel: (event: CarPlayCancelEvent) => void;
};
