export type PlaybackTrack = {
  id: string;
  url: string;
  /** Auth headers for the native engine; web uses ?token= in the URL. */
  headers?: Record<string, string>;
  title: string;
  album?: string;
  artist?: string;
  artwork?: string;
  /** Track duration in seconds, if known. */
  duration?: number;
  /** Web only: `url` is the server's transcoded stream (`?transcode=1`, see
   * `playback/transcode.ts`). It isn't byte-seekable and the element can't know its
   * length, so the web engine seeks by re-requesting with `&t=` and takes the duration
   * from `duration` above. Never set on a local file or on native. */
  transcoded?: boolean;
};

/**
 * A chapter clip for the native engine to play as a clipped media item - the basis
 * for the Android lock screen's chapter-relative scrubber and prev/next-chapter
 * buttons. `fileIndex` indexes into the `tracks` passed to `load`; `startInFile`/
 * `endInFile` bound the clip within that file (`endInFile <= 0` ⇒ play to end of
 * file). The whole-book timeline stays file-based in the store; the native module
 * translates between its chapter items and the file-relative positions it reports.
 * iOS and web ignore this (optional `load` arg).
 */
export type PlaybackChapter = {
  fileIndex: number;
  startInFile: number;
  endInFile: number;
  title: string;
};

/**
 * The browser refused `play()` because nothing the user did allowed sound yet (its
 * autoplay policy, `NotAllowedError`; web only, e.g. a cold `/player` deep link). Not a
 * playback failure: the store reads it as a plain pause, so the play button comes back
 * (a press is the gesture the browser wanted) instead of an error.
 */
export class AutoplayBlockedError extends Error {
  constructor() {
    super('The browser blocked playback until the user interacts with the page');
    this.name = 'AutoplayBlockedError';
  }
}

export type PlaybackState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';

/** Engine status, expressed per-track (the store maps it to the whole-book timeline). */
export type PlaybackSnapshot = {
  state: PlaybackState;
  trackIndex: number;
  /** Position within the current track (seconds). */
  position: number;
  /** Duration of the current track (seconds), if known. */
  duration: number;
  rate: number;
};

export const INITIAL_SNAPSHOT: PlaybackSnapshot = {
  state: 'idle',
  trackIndex: 0,
  position: 0,
  duration: 0,
  rate: 1,
};

/** Runtime tunables, driven by the settings store. */
export type PlaybackConfig = {
  /** Max seconds to rewind when resuming after a pause (0 = disabled). */
  autoRewindMax: number;
  /** Lock-screen / media-session skip-forward interval (seconds). */
  jumpForward: number;
  /** Lock-screen / media-session skip-backward interval (seconds). */
  jumpBackward: number;
  /** Trim the silences between words (native only: Android every book, iOS downloaded
   * books only; the web ignores it). */
  smartSpeed: boolean;
  /** Compress and lift speech (native; web through Web Audio, never in Safari). */
  voiceBoost: boolean;
};

/** A book's identity, as the native engine is told it (`load`'s optional `book`): path is
 * the identity, scoped by connection. The module's `BookRef` has the same shape. */
export type BookRef = { connectionId: string; libraryId: number; path: string };

/**
 * Coerce a caller's volume into the [0,1] linear-gain range every engine expects.
 * A non-finite value (a NaN from a fade computation dividing by a zero duration)
 * falls back to **1**, not 0: an out-of-range volume is a bug, and silence the user
 * can't undo is a far worse failure than a fade that doesn't fade. Web throws on an
 * out-of-range `audio.volume`, so this can't just be advisory.
 */
export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 1;
  return Math.min(1, Math.max(0, volume));
}

/**
 * Platform-agnostic playback engine. Implemented by a custom native module
 * (AVQueuePlayer / Media3) on native and HTML5 Audio on web; the player store
 * talks only to this interface so the engine stays swappable.
 */
export interface PlaybackService {
  setup(): Promise<void>;
  /** Apply runtime tunables (auto-rewind, skip intervals). */
  configure(config: PlaybackConfig): Promise<void>;
  /** `book` names the book being loaded, so a native engine that outlives the JS (the
   * Android service, played from the car) can tell later which book its queue is. The web
   * ignores it. */
  load(
    tracks: PlaybackTrack[],
    startIndex: number,
    positionInTrack: number,
    chapters?: PlaybackChapter[],
    book?: BookRef,
  ): Promise<void>;
  /**
   * Swap the queue to a new source as gaplessly as possible: keep the current
   * source playing until the new one is buffered and ready at `positionInTrack`,
   * then switch. Used to move a streaming book onto its just-downloaded local files
   * without an audible gap. Optional - callers fall back to `load` + `play`.
   *
   * Resolves `true` if the swap happened, `false` if it was refused (e.g. the local
   * source can't be served) and the original source is still playing.
   */
  swapTo?(
    tracks: PlaybackTrack[],
    startIndex: number,
    positionInTrack: number,
    chapters?: PlaybackChapter[],
    book?: BookRef,
  ): Promise<boolean>;
  play(): Promise<void>;
  pause(): Promise<void>;
  /** Seek within the current track. */
  seekTo(positionInTrack: number): Promise<void>;
  skipToTrack(index: number, positionInTrack?: number): Promise<void>;
  setRate(rate: number): Promise<void>;
  /**
   * Set output volume as a linear gain applied to the engine's own volume (NOT the
   * device volume). Used by the sleep timer's fade-out.
   *
   * REQUIRED, and it must stay required: both engines implement it, and the one real
   * "no volume here" case (an installed native binary older than this JS bundle, or
   * iOS Safari's read-only `audio.volume`) is that engine's own private business -
   * each degrades internally to "no fade" and still resolves. An optional marker
   * would push a `?.` onto every caller to model something no caller can act on.
   *
   * Callers pass a value already inside **[0,1]** - `usePlayer.setOutputVolume` is
   * the only route here and clamps once, so engines don't re-clamp (the native side
   * still does, because that crosses a language boundary).
   */
  setVolume(volume: number): Promise<void>;
  reset(): Promise<void>;
  /**
   * Present the OS audio-route / casting picker so the user can send playback to
   * another output: AirPlay on iOS / Safari (→ HomePod, AirPlay speakers), the
   * media-output switcher on Android (→ Bluetooth e.g. an Echo, Cast devices), and
   * the Remote Playback API elsewhere. Resolves `true` if a picker was shown.
   * Optional — engines/platforms without route support omit it.
   */
  showRoutePicker?(): Promise<boolean>;
  /**
   * Whether a route picker can be shown right now, so the UI can hide the button
   * where there's no support (e.g. a desktop browser without Remote Playback or
   * AirPlay). Native engines return true; web checks the available media APIs.
   */
  canShowRoutePicker?(): boolean;
  /**
   * Route the seeks the OS media controls make on the engine itself (web: the Media
   * Session's seekto, seekbackward and seekforward) through `handler`, a track-absolute
   * position, instead of seeking directly. The store passes its own seek, so such a seek
   * lowers the resume floor and saves like any deliberate one: a lock-screen scrub back
   * past the floor's tolerance would otherwise never be saved. Optional; the native
   * module handles its remote commands itself.
   */
  onRemoteSeek?(handler: ((positionInTrack: number) => void) | null): void;
  /**
   * Native: the engine ALREADY moved because of something outside the JS API (the lock
   * screen or notification scrubber, its skip and chapter buttons, a headset, CarPlay,
   * Android Auto and their chapter lists), and landed at `(trackIndex, positionInTrack)`.
   * The engine updates its snapshot BEFORE calling `handler`, so a save inside it saves the
   * new place. The store treats it as the listener's own move (it lowers the resume
   * floor). Not called for moves the JS asked for, auto-rewind, Smart Speed's skips, or a
   * file running on into the next. Optional: the web routes its OS seeks through
   * `onRemoteSeek` instead (its engine has not moved yet when the OS asks).
   */
  onRemoteMove?(handler: ((trackIndex: number, positionInTrack: number) => void) | null): void;
  /** Native: the OS changed the speed (CarPlay's rate button, iOS's rate command, an
   * Android controller) and the engine already applied it. Optional. */
  onRateChange?(handler: ((rate: number) => void) | null): void;
  /** Native: a bookmark button outside the app was pressed (CarPlay, the Android
   * notification / Android Auto), at `(trackIndex, positionInTrack)`. Optional. */
  onRemoteBookmark?(
    handler: ((trackIndex: number, positionInTrack: number) => void) | null,
  ): void;
  /** Native: book seconds Smart Speed has removed since the engine was created (monotonic
   * while that engine lives; a new engine starts again at 0), reported with the engine's
   * progress ticks. Not playback state, so not in the snapshot. Optional, and never called
   * by a binary that predates Smart Speed. */
  onSilenceSaved?(handler: ((totalSeconds: number) => void) | null): void;
  getSnapshot(): PlaybackSnapshot;
  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void;
}
