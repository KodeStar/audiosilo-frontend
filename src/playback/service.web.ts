/// <reference lib="dom" />
import {
  AutoplayBlockedError,
  INITIAL_SNAPSHOT,
  type PlaybackChapter,
  type PlaybackConfig,
  type PlaybackService,
  type PlaybackSnapshot,
  type PlaybackTrack,
} from './types';
import {
  clampTranscodedSeek,
  isEarlyTranscodeEnd,
  TRANSCODE_STALE_PAUSE_MS,
  transcodedTrackPosition,
  transcodeUrlAt,
} from './transcode';

/**
 * Whether a buffered <audio> element is ready to be swapped in for the gapless
 * offline swap: it can play through (`readyState >= HAVE_FUTURE_DATA`, i.e. 3) AND
 * its playhead has reached the seek target (within ~1.5s, since the browser may
 * land slightly off after a seek). A falsy target means the start of the track.
 * Pure and exported so the readiness rule is unit-testable without the DOM.
 */
export function isSwapReady(readyState: number, currentTime: number, target: number): boolean {
  return readyState >= 3 && Math.abs(currentTime - (target || 0)) < 1.5;
}

/**
 * Which OS output picker a media element can present, in priority order: Safari / iOS
 * expose `webkitShowPlaybackTargetPicker` (AirPlay → HomePod, AirPlay speakers);
 * Chromium exposes the Remote Playback API (`el.remote.prompt`, used for Cast). Anything
 * else has no in-page picker. Pure + exported so the choice is unit-testable without a
 * real <audio> element.
 */
export type RoutePickerKind = 'airplay' | 'remote' | 'none';
export function routePickerKind(el: {
  webkitShowPlaybackTargetPicker?: unknown;
  remote?: { prompt?: unknown } | null;
}): RoutePickerKind {
  if (typeof el.webkitShowPlaybackTargetPicker === 'function') return 'airplay';
  if (el.remote && typeof el.remote.prompt === 'function') return 'remote';
  return 'none';
}

/** A media element augmented with the (non-standard) picker entry points. */
type RoutePickerEl = {
  webkitShowPlaybackTargetPicker?: () => void;
  remote?: { prompt?: () => Promise<void> } | null;
};

/**
 * The source to give an element for `track` starting `positionInTrack` in, and the
 * track-absolute time its `currentTime` 0 stands for. A direct stream is the track's
 * own url (the element seeks it by byte range, so `currentTime` is already
 * track-absolute: offset 0). A transcoded stream can't be byte-seeked, so it is
 * requested starting AT the position (`&t=`) and the offset records where it began.
 * Pure + exported so the rule is unit-testable without the DOM.
 */
export function sourceFor(
  track: PlaybackTrack,
  positionInTrack: number,
): { url: string; offset: number } {
  if (!track.transcoded) return { url: track.url, offset: 0 };
  const t = clampTranscodedSeek(positionInTrack, track.duration);
  return { url: transcodeUrlAt(track.url, t), offset: t };
}

/**
 * Web playback via a single HTML5 <audio> element. The token is already in the
 * track URL (query param), so Range requests (seek/scrub) work natively. The
 * queue is advanced manually on `ended`. Media Session API wires up OS / browser
 * lock-screen transport controls.
 *
 * A TRANSCODED track (`track.transcoded`, see `playback/transcode.ts`) is the
 * server's on-the-fly MP3, which has no byte ranges and no length the element knows:
 * every seek re-requests it with `&t=`, `offset` holds where the current request
 * began, and the snapshot's `position` stays track-absolute (`currentTime + offset`)
 * so the store's whole-book math never sees the restart. Its duration comes from the
 * queue (`track.duration`), never the element (which reads Infinity/NaN).
 */
class WebPlaybackService implements PlaybackService {
  private audio: HTMLAudioElement | null = null;
  private tracks: PlaybackTrack[] = [];
  private index = 0;
  private rate = 1;
  /** Last requested output volume, re-applied to every element we create (a fade
   * mid-`swapTo` would otherwise jump back to full on the swapped-in element). */
  private volume = 1;
  private config: PlaybackConfig = { autoRewindMax: 0, jumpForward: 30, jumpBackward: 15 };
  private pausedAt: number | null = null;
  /** Track-absolute start (seconds) of the active element's source: the `t` a
   * transcoded stream was requested at, 0 for a direct stream. */
  private offset = 0;
  /** Bumped per `loadTrack`, so a `loadedmetadata` handler left over from an earlier
   * source (a quick second seek replaces the src before the first one loads) can't seek
   * or autoplay the new one. */
  private loadSeq = 0;
  /** A transcoded track is mid-reload with playback intended: set by `play()` and an
   * autoplaying load, cleared on `playing`, `pause()` and `reset()`. A transcoded seek
   * reloads the source, so the `loading` window recurs on every seek, and a second seek
   * (or skip) inside it must keep playing. */
  private pendingAutoplay = false;
  /** The track-absolute position the last early-end reload started from (see
   * `isEarlyTranscodeEnd`), null when none is in play. */
  private earlyEndRetryAt: number | null = null;
  /** Whether we set an explicit Media Session position state (transcoded tracks), so a
   * later direct track can clear it back to the browser's own. */
  private positionStateSet = false;
  private snapshot: PlaybackSnapshot = { ...INITIAL_SNAPSHOT };
  private listeners = new Set<(s: PlaybackSnapshot) => void>();

  private emit() {
    for (const listener of this.listeners) listener(this.snapshot);
  }
  private update(patch: Partial<PlaybackSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.syncPositionState();
    this.emit();
  }

  private current(): PlaybackTrack | undefined {
    return this.tracks[this.index];
  }

  /** The active element's track-absolute position: `currentTime` itself for a direct
   * stream (unchanged behaviour), `currentTime + offset` for a transcoded one. */
  private positionOf(a: HTMLAudioElement): number {
    const track = this.current();
    return track?.transcoded
      ? transcodedTrackPosition(a.currentTime, this.offset, track.duration)
      : a.currentTime;
  }

  /** Is playback running or about to (see `pendingAutoplay`)? For a direct stream this
   * is exactly the old `state === 'playing'` test. */
  private intendsToPlay(): boolean {
    return (
      this.snapshot.state === 'playing' || (!!this.current()?.transcoded && this.pendingAutoplay)
    );
  }

  /** Apply the rate so it survives a source change: the media element load algorithm
   * resets `playbackRate` to `defaultPlaybackRate`, which a transcoded seek (a new src
   * each time) would otherwise drop back to 1x. */
  private applyRate(a: HTMLAudioElement) {
    a.defaultPlaybackRate = this.rate;
    a.playbackRate = this.rate;
  }

  /** Create an <audio> with all listeners wired. Each listener no-ops unless its
   * element is the active one, so a buffering element being prepared by `swapTo`
   * can't drive the snapshot until we switch to it. */
  private createAudio(): HTMLAudioElement {
    const a = new Audio();
    a.preload = 'auto';
    this.applyVolume(a);
    const active = () => a === this.audio;
    a.addEventListener(
      'timeupdate',
      () => active() && this.update({ position: this.positionOf(a) }),
    );
    a.addEventListener('durationchange', () => {
      // A transcoded stream's element duration is Infinity/NaN or, at best, the length
      // of the remaining output; the track's known duration stands (set on load).
      if (active() && !this.current()?.transcoded && Number.isFinite(a.duration)) {
        this.update({ duration: a.duration });
      }
    });
    a.addEventListener('playing', () => {
      if (!active()) return;
      this.pendingAutoplay = false;
      this.update({ state: 'playing' });
    });
    a.addEventListener('pause', () => {
      if (active() && this.snapshot.state !== 'ended') this.update({ state: 'paused' });
    });
    a.addEventListener('waiting', () => active() && this.update({ state: 'loading' }));
    a.addEventListener('ended', () => active() && this.handleEnded());
    a.addEventListener('error', () => active() && this.update({ state: 'error' }));
    return a;
  }

  private el(): HTMLAudioElement {
    if (!this.audio) this.audio = this.createAudio();
    return this.audio;
  }

  private loadTrack(index: number, positionInTrack: number, autoplay: boolean) {
    const track = this.tracks[index];
    if (!track) return;
    const a = this.el();
    this.index = index;
    const source = sourceFor(track, positionInTrack);
    this.offset = source.offset;
    this.earlyEndRetryAt = null; // handleEnded re-sets it for its own reload
    if (track.transcoded) this.pendingAutoplay = autoplay;
    const seq = ++this.loadSeq;
    a.src = source.url;
    this.applyRate(a);
    this.update({
      trackIndex: index,
      // A transcoded stream starts at the clamped `t` it was requested at.
      position: track.transcoded ? source.offset : positionInTrack,
      duration: track.duration ?? 0,
      state: 'loading',
    });
    this.setMediaSession(track);
    const onLoaded = () => {
      a.removeEventListener('loadedmetadata', onLoaded);
      if (seq !== this.loadSeq) return; // a later load replaced this source
      // A transcoded stream already starts at the position (its 0 is `offset`).
      if (!track.transcoded) {
        try {
          a.currentTime = positionInTrack || 0;
        } catch {
          // seeking before ready; timeupdate will correct
        }
      }
      if (autoplay) {
        // A play() interrupted by the next source change rejects with AbortError;
        // that load owns playback now.
        a.play()?.catch(() => undefined);
      }
    };
    a.addEventListener('loadedmetadata', onLoaded);
    a.load();
  }

  /** Re-request the current transcoded track at a track-absolute position (a seek, an
   * auto-rewind, a stale resume, an early end), keeping play intent. */
  private reloadTranscodedAt(positionInTrack: number, autoplay: boolean) {
    this.loadTrack(this.index, positionInTrack, autoplay);
  }

  private handleEnded() {
    const track = this.current();
    if (track?.transcoded && this.audio) {
      // An unsized stream that the server or a proxy closed reads as a normal end; if
      // that happened well before the file's known end, pick up where it stopped
      // instead of skipping the rest of the file.
      const position = this.positionOf(this.audio);
      if (isEarlyTranscodeEnd(position, track.duration, this.earlyEndRetryAt)) {
        this.reloadTranscodedAt(position, true);
        this.earlyEndRetryAt = position; // after the reload, which clears it
        return;
      }
    }
    if (this.index < this.tracks.length - 1) {
      this.loadTrack(this.index + 1, 0, true);
    } else {
      this.update({ state: 'ended' });
    }
  }

  async setup() {
    /* no-op on web */
  }

  async configure(config: PlaybackConfig) {
    this.config = config;
  }

  async load(
    tracks: PlaybackTrack[],
    startIndex: number,
    positionInTrack: number,
    _chapters?: PlaybackChapter[], // chapters are a native lock-screen concern; web ignores them
  ) {
    this.tracks = tracks;
    this.loadTrack(startIndex, positionInTrack, false);
    this.update({ state: 'ready' });
  }

  async swapTo(
    tracks: PlaybackTrack[],
    startIndex: number,
    positionInTrack: number,
    _chapters?: PlaybackChapter[], // ignored on web (see load)
  ): Promise<boolean> {
    const track = tracks[startIndex];
    if (!track) return false;

    // Downloaded files live behind synthetic `…/_offline/…` urls that only resolve
    // when our service worker is controlling this page (it serves them from the
    // Cache API). If it isn't - unsupported, registration delayed/failed, or a
    // non-PWA first load that hasn't been claimed yet - the url 404s. Switching to a
    // dead source would stop playback with no way to resume, so refuse the swap and
    // keep streaming; a later open of the book will pick up the local copy.
    if (
      track.url.includes('/_offline/') &&
      !(typeof navigator !== 'undefined' && navigator.serviceWorker?.controller)
    ) {
      return false;
    }

    const wasPlaying = this.intendsToPlay();

    // Buffer the new (local) source on a separate element while the current one
    // keeps playing, then switch - so there's no silent gap while it loads/seeks.
    // (A local copy is never transcoded, so `source` is the plain url at offset 0;
    // sourceFor keeps the rule in one place should that ever change.)
    const source = sourceFor(track, positionInTrack);
    const target = positionInTrack - source.offset; // where the element's playhead must be
    const pending = this.createAudio();
    pending.src = source.url;
    this.applyRate(pending);
    const ready = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        pending.removeEventListener('loadedmetadata', onLoaded);
        pending.removeEventListener('canplay', onReady);
        pending.removeEventListener('seeked', onReady);
        pending.removeEventListener('error', onError);
        resolve(ok);
      };
      const onLoaded = () => {
        if (track.transcoded) return; // already starts at the target
        try {
          pending.currentTime = target || 0;
        } catch {
          // can't seek yet; the readiness check below retries via `seeked`
        }
      };
      // Ready once it can play AND the playhead is at the seek target.
      const onReady = () => {
        if (isSwapReady(pending.readyState, pending.currentTime, target)) done(true);
      };
      const onError = () => done(false);
      pending.addEventListener('loadedmetadata', onLoaded);
      pending.addEventListener('canplay', onReady);
      pending.addEventListener('seeked', onReady);
      pending.addEventListener('error', onError);
      pending.load();
      setTimeout(() => done(false), 8000); // never hang; a slow load counts as a failed swap
    });

    // The local source never became playable - discard it and keep streaming rather
    // than cutting the live element over to a dead one.
    if (!ready) {
      pending.pause();
      pending.removeAttribute('src');
      pending.load();
      return false;
    }

    // Switch. The active() guard makes the old element's teardown events no-ops.
    const old = this.audio;
    this.audio = pending;
    this.tracks = tracks;
    this.index = startIndex;
    this.offset = source.offset;
    this.pendingAutoplay = false;
    this.earlyEndRetryAt = null;
    this.loadSeq++; // the old element's pending load handler (if any) is moot
    if (old) {
      old.pause();
      old.removeAttribute('src');
      old.load();
    }
    this.setMediaSession(track);
    this.update({
      trackIndex: startIndex,
      position: positionInTrack,
      duration:
        track.duration ??
        (!track.transcoded && Number.isFinite(pending.duration) ? pending.duration : 0),
      state: wasPlaying ? 'playing' : 'paused',
    });
    if (wasPlaying) {
      try {
        await pending.play();
      } catch {
        // autoplay shouldn't be blocked mid-session, but ignore if it is
      }
    }
    return true;
  }

  /** `a.play()`, with the browser's autoplay refusal (`NotAllowedError`: no user gesture
   * yet) settled to `paused` and reported as `AutoplayBlockedError`, so the store can read
   * it as a pause; any other failure is rethrown as is. */
  private async playElement(a: HTMLAudioElement) {
    try {
      await a.play();
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name !== 'NotAllowedError') throw err;
      this.pendingAutoplay = false;
      if (a === this.audio) this.update({ state: 'paused' });
      throw new AutoplayBlockedError();
    }
  }

  async play() {
    const a = this.el();
    const pausedFor = this.pausedAt != null ? Date.now() - this.pausedAt : 0;
    const rewind =
      this.config.autoRewindMax > 0 && this.pausedAt != null
        ? Math.min(this.config.autoRewindMax, pausedFor / 1000)
        : 0;
    this.pausedAt = null;
    if (this.current()?.transcoded) {
      this.pendingAutoplay = true;
      // A transcoded stream can't seek in place: an auto-rewind re-requests it further
      // back, and so does a resume after a long pause (the paused transcode may have
      // been dropped; resuming a dead connection would only stall into the watchdog).
      if (rewind > 0.5 || pausedFor > TRANSCODE_STALE_PAUSE_MS) {
        this.reloadTranscodedAt(Math.max(0, this.snapshot.position - rewind), true);
        return;
      }
      await this.playElement(a);
      return;
    }
    if (rewind > 0.5) a.currentTime = Math.max(0, a.currentTime - rewind);
    await this.playElement(a);
  }

  async pause() {
    this.el().pause();
    this.pausedAt = Date.now();
    this.pendingAutoplay = false;
  }

  async seekTo(positionInTrack: number) {
    const track = this.current();
    if (track?.transcoded) {
      // Not byte-seekable: re-request the stream from the target (track-absolute).
      this.reloadTranscodedAt(
        clampTranscodedSeek(positionInTrack, track.duration),
        this.intendsToPlay(),
      );
      return;
    }
    const a = this.el();
    // Clamp to [0, duration] so the optimistic snapshot can't momentarily exceed
    // the real track length (the browser clamps currentTime, but the snapshot
    // drives the whole-book position mapping).
    const dur = Number.isFinite(a.duration) ? a.duration : undefined;
    const clamped = Math.max(0, dur != null ? Math.min(positionInTrack, dur) : positionInTrack);
    a.currentTime = clamped;
    this.update({ position: clamped });
  }

  async skipToTrack(index: number, positionInTrack = 0) {
    const wasPlaying = this.intendsToPlay();
    this.loadTrack(index, positionInTrack, wasPlaying);
  }

  async setRate(rate: number) {
    this.rate = rate;
    if (this.audio) this.applyRate(this.audio);
    this.update({ rate });
  }

  async setVolume(volume: number) {
    // Stored as given: the store clamps into [0,1] before it gets here (see
    // `PlaybackService.setVolume`), so re-clamping would only hide a caller bug.
    this.volume = volume;
    if (this.audio) this.applyVolume(this.audio);
  }

  /** iOS Safari refuses per-element volume (the system volume is the only control there),
   * so a fade is simply inaudible on iPhone/iPad web - it must never become a thrown
   * error that kills playback. Everywhere else this is the real gain control. */
  private applyVolume(a: HTMLAudioElement) {
    try {
      a.volume = this.volume;
    } catch {
      // read-only / unsupported on this platform; degrade to no fade
    }
  }

  async reset() {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    this.tracks = [];
    this.index = 0;
    this.offset = 0;
    this.loadSeq++;
    this.pendingAutoplay = false;
    this.earlyEndRetryAt = null;
    this.snapshot = { ...INITIAL_SNAPSHOT, rate: this.rate };
    this.syncPositionState();
    this.emit();
  }

  canShowRoutePicker(): boolean {
    if (typeof Audio === 'undefined') return false;
    return routePickerKind(this.el() as unknown as RoutePickerEl) !== 'none';
  }

  async showRoutePicker(): Promise<boolean> {
    const el = this.el() as unknown as RoutePickerEl;
    switch (routePickerKind(el)) {
      case 'airplay':
        // Safari / iOS: opens the native AirPlay route sheet for this element. Can throw
        // (e.g. InvalidStateError when AirPlay can't be presented); treat that as "not
        // shown" rather than letting it become an unhandled rejection (the caller uses
        // `void showRoutePicker()`). Symmetric with the remote branch below.
        try {
          el.webkitShowPlaybackTargetPicker?.();
          return true;
        } catch {
          return false;
        }
      case 'remote':
        // Chromium: opens the Cast/Remote Playback chooser; rejects if the user
        // dismisses it or there are no devices — neither is an error here.
        try {
          await el.remote?.prompt?.();
          return true;
        } catch {
          return false;
        }
      default:
        return false;
    }
  }

  getSnapshot() {
    return this.snapshot;
  }

  subscribe(listener: (s: PlaybackSnapshot) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setMediaSession(track: PlaybackTrack) {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork: track.artwork ? [{ src: track.artwork }] : [],
      });
      navigator.mediaSession.setActionHandler('play', () => void this.play());
      navigator.mediaSession.setActionHandler('pause', () => void this.pause());
      navigator.mediaSession.setActionHandler(
        'seekbackward',
        () => void this.seekTo(Math.max(0, this.snapshot.position - this.config.jumpBackward)),
      );
      navigator.mediaSession.setActionHandler(
        'seekforward',
        () => void this.seekTo(this.snapshot.position + this.config.jumpForward),
      );
      // The OS scrubber would otherwise seek the element itself, which a transcoded
      // stream can't do (no byte ranges); route it through seekTo's re-request. A
      // direct stream keeps the browser's default (null = no handler, as before).
      navigator.mediaSession.setActionHandler(
        'seekto',
        track.transcoded ? (d) => void this.seekTo(d.seekTime ?? 0) : null,
      );
    } catch {
      // unsupported action handlers; ignore
    }
  }

  /**
   * Media Session position state for a transcoded track: the browser would derive it
   * from the element, whose duration is Infinity and whose time restarts at 0 on every
   * seek. So report the track-absolute position and the known duration ourselves, and
   * hand control back (clear it) once a direct track plays. Untouched for direct
   * streams that never had one set.
   */
  private syncPositionState() {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    if (typeof ms.setPositionState !== 'function') return;
    const track = this.current();
    const duration = track?.transcoded ? (track.duration ?? 0) : 0;
    try {
      if (duration > 0) {
        ms.setPositionState({
          duration,
          playbackRate: this.rate,
          position: Math.min(Math.max(0, this.snapshot.position), duration),
        });
        this.positionStateSet = true;
      } else if (this.positionStateSet) {
        ms.setPositionState();
        this.positionStateSet = false;
      }
    } catch {
      // a browser that rejects the values; the lock screen just shows less
    }
  }
}

export function createPlaybackService(): PlaybackService {
  return new WebPlaybackService();
}
