/// <reference lib="dom" />
import { supportsVoiceBoost } from './effects';
import {
  AutoplayBlockedError,
  type BookRef,
  INITIAL_SNAPSHOT,
  type PlaybackChapter,
  type PlaybackConfig,
  type PlaybackService,
  type PlaybackSnapshot,
  type PlaybackTrack,
} from './types';
import {
  isEarlyTranscodeEnd,
  TRANSCODE_STALE_PAUSE_MS,
  transcodedTrackPosition,
  transcodeStartAt,
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

// The web engine is where `supportsVoiceBoost` is asked (contract decision 7); the rule
// itself lives with the other platform rules in `effects.ts`, so the UI can read it on
// every platform without importing this engine.
export { supportsVoiceBoost };

/** Voice Boost's compressor (contract decision 7): the same numbers as the native boost's
 * compressor, in the units `DynamicsCompressorNode` takes (seconds for the times). */
export const VOICE_BOOST_COMPRESSOR = {
  threshold: -24,
  knee: 6,
  ratio: 3,
  attack: 0.005,
  release: 0.25,
} as const;

/**
 * Is `url` served from this page's own origin? A media element routed through Web Audio
 * whose source is cross-origin (without CORS) plays SILENCE (the spec's "outputs zeroes"
 * for a tainted source), so only a same-origin source is ever routed: the player served at
 * `/web` by the server it plays from, and the service worker's `/_offline/` copies. A
 * stream from another signed-in server plays on unboosted. Pure + exported for the tests.
 */
export function isSameOrigin(url: string, page: { href: string; origin: string } | undefined) {
  if (!page) return false;
  try {
    return new URL(url, page.href).origin === page.origin;
  } catch {
    return false;
  }
}

const pageLocation = (): { href: string; origin: string } | undefined =>
  typeof location !== 'undefined' ? location : undefined;

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
 * requested starting AT the position (`&t=`, never inside the file's last second: see
 * `transcodeStartAt`) and the offset records where it began.
 * Pure + exported so the rule is unit-testable without the DOM.
 */
export function sourceFor(
  track: PlaybackTrack,
  positionInTrack: number,
): { url: string; offset: number } {
  if (!track.transcoded) return { url: track.url, offset: 0 };
  const t = transcodeStartAt(positionInTrack, track.duration);
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
  private config: PlaybackConfig = {
    autoRewindMax: 0,
    jumpForward: 30,
    jumpBackward: 15,
    smartSpeed: false,
    voiceBoost: false,
  };
  /** Whether `configure` has run once: the first call is the store's set-up (no gesture),
   * every later one is a setting the listener changed. */
  private configured = false;
  /** Voice Boost's Web Audio graph: ONE context and ONE compressor (-> destination),
   * created lazily inside a listener's gesture (the switch, or a play tap with the setting
   * on) and never torn down; switching the boost off reconnects each source straight to
   * the destination. Never created where `supportsVoiceBoost` says no (Safari). */
  private boost: { ctx: AudioContext; compressor: DynamicsCompressorNode } | null = null;
  /** Each element's source node. An element takes exactly ONE for its whole life (a second
   * `createMediaElementSource` throws), and once it has one its sound only comes out
   * through the graph: so it is only made while the context is running (a suspended one
   * would silence the book) and only for a same-origin source (see `isSameOrigin`). */
  private sources = new Map<HTMLAudioElement, MediaElementAudioSourceNode>();
  private pausedAt: number | null = null;
  /** Track-absolute start (seconds) of the active element's source: the `t` a
   * transcoded stream was requested at, 0 for a direct stream. */
  private offset = 0;
  /** Bumped per `loadTrack`, so a `loadedmetadata` handler left over from an earlier
   * source (a quick second seek replaces the src before the first one loads) can't seek
   * or autoplay the new one. */
  private loadSeq = 0;
  /** Playback is intended but hasn't started yet: set by an autoplaying load (the
   * advance to the next file, a skip or a transcoded seek while playing) and by `play()`
   * on a transcoded track; cleared on `playing`, `error`, `pause()` and `reset()`. A load
   * plays only if this is still set when its metadata arrives, so a pause inside the
   * window (the listener's, or the sleep timer's at a chapter end) holds. A transcoded
   * seek reloads the source, so the window recurs on every seek, and a second seek (or a
   * skip) inside it must keep playing. */
  private pendingAutoplay = false;
  /** The track-absolute position the last early-end reload started from (see
   * `isEarlyTranscodeEnd`), null when none is in play. */
  private earlyEndRetryAt: number | null = null;
  /** Whether we set an explicit Media Session position state (transcoded tracks), so a
   * later direct track can clear it back to the browser's own. */
  private positionStateSet = false;
  /** The store's seek, for the OS media controls (see `onRemoteSeek`). */
  private remoteSeek: ((positionInTrack: number) => void) | null = null;
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

  /** Is playback running or about to (see `pendingAutoplay`)? A skip while the next file
   * loads after an advance, or while a transcoded seek reloads, keeps playing. So does one
   * during a network stall: 'waiting' reports `loading` but leaves the element unpaused,
   * and a transcoded seek there reloads the source; reloading it paused would leave the
   * store wanting playback that never comes, which its stall watchdog turns into an error.
   * (A load pauses the element, so a `loading` from a load never reads as playing here.) */
  private intendsToPlay(): boolean {
    if (this.pendingAutoplay) return true;
    const { state } = this.snapshot;
    return state === 'playing' || (state === 'loading' && !!this.audio && !this.audio.paused);
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
      if (!active() || this.snapshot.state === 'ended') return;
      // At a file's natural end the element pauses itself just before 'ended' (the HTML
      // spec's order). When another file follows, handleEnded moves straight on to it, so
      // this is not the listener pausing: reporting it would clear the store's play intent
      // at every file boundary, and a sleep timer aimed at that boundary would find the
      // book stopped, expire without pausing it, and let the next file play on. The last
      // file still reports the pause, then 'ended'.
      if (a.ended && this.index < this.tracks.length - 1) return;
      this.update({ state: 'paused' });
    });
    a.addEventListener('waiting', () => active() && this.update({ state: 'loading' }));
    a.addEventListener('ended', () => active() && this.handleEnded());
    a.addEventListener('error', () => {
      if (!active()) return;
      // A source that failed will never start, so nothing is about to play: a stale
      // intent would have a later skip, or the swap onto the downloaded copy, start the
      // book by itself long after the error.
      this.pendingAutoplay = false;
      this.update({ state: 'error' });
    });
    return a;
  }

  private el(): HTMLAudioElement {
    if (!this.audio) this.audio = this.createAudio();
    return this.audio;
  }

  private loadTrack(index: number, positionInTrack: number, autoplay: boolean) {
    const track = this.tracks[index];
    if (!track) return;
    const source = sourceFor(track, positionInTrack);
    // An element already routed through Voice Boost would play another server's stream
    // as silence (see `isSameOrigin`): give that source a fresh, unrouted element. A load
    // interrupts playback anyway, so the change is inaudible.
    if (this.audio && this.sources.has(this.audio) && !isSameOrigin(source.url, pageLocation())) {
      this.discard(this.audio);
      this.audio = null;
    }
    const a = this.el();
    this.index = index;
    this.offset = source.offset;
    this.earlyEndRetryAt = null; // handleEnded re-sets it for its own reload
    this.pendingAutoplay = autoplay;
    const seq = ++this.loadSeq;
    a.src = source.url;
    this.applyRate(a);
    this.routeBoost(a);
    this.update({
      trackIndex: index,
      // A transcoded stream starts at the `t` it was requested at (see `sourceFor`).
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
      // Read the intent now, not as it was when the load began: a pause inside the load
      // (the listener's, or the sleep timer's) cleared it and must hold.
      if (this.pendingAutoplay) {
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
    const switchedOn = config.voiceBoost && !this.config.voiceBoost;
    this.config = config;
    // Turned on by the listener (a later call than the store's set-up): that is a gesture,
    // the moment a browser lets an AudioContext start. Smart Speed has no web engine.
    if (switchedOn && this.configured) this.ensureBoostGraph();
    this.configured = true;
    if (this.audio) this.routeBoost(this.audio);
  }

  /** Voice Boost wanted, and possible in this browser. */
  private wantsBoost(): boolean {
    return this.config.voiceBoost && supportsVoiceBoost();
  }

  /** Make the graph if Voice Boost is wanted and there is none yet, and ask the context to
   * run. Call it inside a listener's gesture (the switch, a play tap): the browser only
   * lets an AudioContext start then. Synchronous up to `resume()`, so the gesture holds. */
  private ensureBoostGraph() {
    if (!this.wantsBoost()) return;
    if (!this.boost) {
      try {
        const ctx = new AudioContext();
        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = VOICE_BOOST_COMPRESSOR.threshold;
        compressor.knee.value = VOICE_BOOST_COMPRESSOR.knee;
        compressor.ratio.value = VOICE_BOOST_COMPRESSOR.ratio;
        compressor.attack.value = VOICE_BOOST_COMPRESSOR.attack;
        compressor.release.value = VOICE_BOOST_COMPRESSOR.release;
        compressor.connect(ctx.destination);
        this.boost = { ctx, compressor };
        // Route the playing element once the context actually runs (see `sources`).
        ctx.addEventListener('statechange', () => {
          if (this.audio) this.routeBoost(this.audio);
        });
      } catch {
        return; // no Web Audio after all: the book plays on unboosted
      }
    }
    if (this.boost.ctx.state !== 'running') {
      this.boost.ctx.resume().catch(() => undefined);
    }
  }

  /**
   * Point `a`'s sound where the setting says: through the compressor when Voice Boost is
   * on, straight to the destination when it is off. An element is only given a source node
   * (which it then keeps for life) while the context RUNS and its source is same-origin;
   * until then it plays on by itself, unboosted, which is never worse than silence. An
   * element that never had one stays as it is while the boost is off.
   */
  private routeBoost(a: HTMLAudioElement) {
    const boost = this.boost;
    if (!boost) return;
    let source = this.sources.get(a);
    if (!source) {
      if (!this.wantsBoost() || boost.ctx.state !== 'running') return;
      if (!isSameOrigin(a.src, pageLocation())) return;
      try {
        source = boost.ctx.createMediaElementSource(a);
      } catch {
        return;
      }
      this.sources.set(a, source);
    }
    source.disconnect();
    source.connect(this.wantsBoost() ? boost.compressor : boost.ctx.destination);
  }

  /** Stop and drop an element we no longer use, and its source node with it. */
  private discard(a: HTMLAudioElement) {
    a.pause();
    a.removeAttribute('src');
    a.load();
    const source = this.sources.get(a);
    if (source) {
      source.disconnect();
      this.sources.delete(a);
    }
  }

  async load(
    tracks: PlaybackTrack[],
    startIndex: number,
    positionInTrack: number,
    _chapters?: PlaybackChapter[], // chapters are a native lock-screen concern; web ignores them
    _book?: BookRef, // a native concern too (the Android service)
  ) {
    this.tracks = tracks;
    // A pause belongs to what was loaded before: the first play() of a new load must not
    // auto-rewind (or, transcoded, re-request the stream early) for it.
    this.pausedAt = null;
    this.loadTrack(startIndex, positionInTrack, false);
    this.update({ state: 'ready' });
  }

  async swapTo(
    tracks: PlaybackTrack[],
    startIndex: number,
    positionInTrack: number,
    _chapters?: PlaybackChapter[], // ignored on web (see load)
    _book?: BookRef, // ignored on web (see load)
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
      this.discard(pending);
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
    if (old) this.discard(old);
    // The swapped-in element gets its own source node (an element's one for life).
    this.routeBoost(pending);
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
    // A play tap is a gesture: the moment to make (or wake) Voice Boost's graph, before
    // anything here awaits.
    this.ensureBoostGraph();
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
    const a = this.el();
    // Inside a load the element is already paused (the load algorithm pauses it without
    // a 'pause' event), so no event will settle the snapshot: settle it here, or a pause
    // during a load would leave it on 'loading', a spinner nothing comes to end.
    const settle = a.paused && this.snapshot.state === 'loading';
    a.pause();
    this.pausedAt = Date.now();
    this.pendingAutoplay = false;
    if (settle) this.update({ state: 'paused' });
  }

  async seekTo(positionInTrack: number) {
    const track = this.current();
    if (track?.transcoded) {
      // Not byte-seekable: re-request the stream from the target (track-absolute),
      // never at the very end, where there is nothing left to encode.
      this.reloadTranscodedAt(
        transcodeStartAt(positionInTrack, track.duration),
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
    this.pausedAt = null;
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

  onRemoteSeek(handler: ((positionInTrack: number) => void) | null) {
    this.remoteSeek = handler;
  }

  /** A seek from the OS media controls: through the store when it listens, so the resume
   * floor and the save treat it like any deliberate seek. */
  private seekFromOs(positionInTrack: number) {
    if (this.remoteSeek) this.remoteSeek(positionInTrack);
    else void this.seekTo(positionInTrack);
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
      navigator.mediaSession.setActionHandler('seekbackward', () =>
        this.seekFromOs(Math.max(0, this.snapshot.position - this.config.jumpBackward)),
      );
      navigator.mediaSession.setActionHandler('seekforward', () =>
        this.seekFromOs(this.snapshot.position + this.config.jumpForward),
      );
      // The OS scrubber would otherwise seek the element itself, which a transcoded
      // stream can't do (no byte ranges); route it through the store's seek, which
      // re-requests it. A direct stream keeps the browser's default (null = no handler,
      // as before).
      navigator.mediaSession.setActionHandler(
        'seekto',
        track.transcoded ? (d) => this.seekFromOs(d.seekTime ?? 0) : null,
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
