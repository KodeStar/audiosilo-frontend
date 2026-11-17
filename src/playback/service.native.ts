import type { EventSubscription } from 'expo-modules-core';

import { routed } from '@/cast/routed-service';

import AudiosiloPlayer from '../../modules/audiosilo-player';

import {
  type BookRef,
  INITIAL_SNAPSHOT,
  type PlaybackChapter,
  type PlaybackConfig,
  type PlaybackService,
  type PlaybackSnapshot,
  type PlaybackTrack,
  toNativeTrack,
} from './types';

/** How long a progress tick whose place jumped waits for its move's `onRemoteMove`
 * (`NativePlaybackService.progress`): Android sends it at most 300 ms after the tick. */
const LANDING_HOLD_MS = 600;
/** How far a tick must move past what playing explains to have jumped: ahead, beyond the
 * time since the last tick at the speed; back, a second. */
const LANDING_AHEAD_S = 5;
const LANDING_BACK_S = 1;

/** Does the installed binary know the car-era module surface (`load`'s 5th `book` argument
 * among it)? The JS bundle can be newer than the binary (a shipped store build lags), and
 * an Expo function called with more arguments than it declares THROWS ("received 5
 * arguments, expected 4", expo-modules-core's argument count check on both platforms), so
 * the `book` argument is only passed to a binary that also has `getLoadedBook`: the two
 * ship together. */
function moduleTakesBook(): boolean {
  return typeof AudiosiloPlayer.getLoadedBook === 'function';
}

/**
 * Native playback via the local `audiosilo-player` module (AVQueuePlayer on iOS,
 * Media3/ExoPlayer on Android). The module handles background audio, gapless
 * multi-file playback, lock-screen controls + remote commands, and pitch-corrected
 * speed. The whole-book timeline lives in the player store; this engine works
 * per-track. The module's `NativeState` values match `PlaybackState` 1:1.
 *
 * The newer events (`onRemoteMove`, `onRateChange`, `silenceSaved` on `onProgress`) are
 * listened for on every binary: an older one simply never sends them, and listening for an
 * event a module doesn't declare is harmless. (`onRemoteBookmark` is the car's: see
 * `src/car/car-native.native.ts`.)
 */
class NativePlaybackService implements PlaybackService {
  private snapshot: PlaybackSnapshot = { ...INITIAL_SNAPSHOT };
  private listeners = new Set<(s: PlaybackSnapshot) => void>();
  private subscriptions: EventSubscription[] = [];
  private setupDone = false;
  private remoteMove: ((trackIndex: number, positionInTrack: number) => void) | null = null;
  private rateChange: ((rate: number) => void) | null = null;
  private silenceSaved: ((totalSeconds: number) => void) | null = null;
  /** A progress tick whose place jumped while playing, held back (`LANDING_HOLD_MS`). */
  private held: {
    position: number;
    duration: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** The last progress tick the snapshot took in this stretch of playing, and when. */
  private lastTick: { position: number; trackIndex: number; at: number } | null = null;

  private emit() {
    for (const listener of this.listeners) listener(this.snapshot);
  }
  private update(patch: Partial<PlaybackSnapshot>) {
    // A place set by anything else replaces a held tick's.
    if (patch.position !== undefined || patch.trackIndex !== undefined) this.dropHeld();
    this.snapshot = { ...this.snapshot, ...patch };
    if (patch.state !== undefined && patch.state !== 'playing') this.lastTick = null;
    this.emit();
  }
  private dropHeld() {
    if (this.held) clearTimeout(this.held.timer);
    this.held = null;
  }

  /**
   * A progress tick (fe#211). A lock-screen, headset or car move lands in a tick (`onProgress`)
   * before its `onRemoteMove`: iOS sends the two together, Android the move with the next
   * position change or 300 ms later. Taken at once, the store's save, its 15 s cut or its 5 s
   * keep could end the listening span at the landed place before it heard of the move, so the
   * move read as listening up to there. So a tick whose place jumped while playing (in the
   * same file, past what the time since the last tick plays at the speed, or back) waits up to
   * `LANDING_HOLD_MS` for that move, which then replaces it; a move the engine made by itself
   * (never reported) is taken once the wait is over. The first tick of a play is never held
   * (a resume's auto-rewind is the engine's own move).
   */
  private progress(position: number, duration: number) {
    const now = Date.now();
    const last = this.lastTick;
    const playing = this.snapshot.state === 'playing';
    const jumped =
      playing &&
      last !== null &&
      last.trackIndex === this.snapshot.trackIndex &&
      (position - last.position >
        ((now - last.at) / 1000) * (this.snapshot.rate || 1) + LANDING_AHEAD_S ||
        position < last.position - LANDING_BACK_S);
    if (jumped || this.held) {
      // Held, or a later tick while one is: the newest place waits, on the first one's clock.
      const timer = this.held?.timer ?? setTimeout(() => this.releaseHeld(), LANDING_HOLD_MS);
      this.held = { position, duration, timer };
      return;
    }
    this.takeTick(position, duration, now);
  }
  private releaseHeld() {
    const held = this.held;
    if (!held) return;
    clearTimeout(held.timer);
    this.held = null;
    this.takeTick(held.position, held.duration, Date.now());
  }
  private takeTick(position: number, duration: number, at: number) {
    this.snapshot = { ...this.snapshot, position, duration };
    if (this.snapshot.state === 'playing') {
      this.lastTick = { position, trackIndex: this.snapshot.trackIndex, at };
    }
    this.emit();
  }

  async setup() {
    if (this.setupDone) return;
    this.subscriptions.push(
      AudiosiloPlayer.addListener('onState', ({ state }) => this.update({ state })),
      AudiosiloPlayer.addListener('onProgress', ({ position, duration, silenceSaved }) => {
        this.progress(position, duration);
        // Absent on binaries older than Smart Speed.
        if (typeof silenceSaved === 'number' && Number.isFinite(silenceSaved)) {
          this.silenceSaved?.(silenceSaved);
        }
      }),
      AudiosiloPlayer.addListener('onTrackChange', ({ index }) => {
        // A held tick was the file it leaves: taken first.
        this.releaseHeld();
        this.update({ trackIndex: index });
      }),
      // The engine already moved (the lock screen, a headset, the car): the store hears of
      // the move first, its landed place (this snapshot's, `getSnapshot`) right after, so its
      // listening span ends where the engine was, never at the landed place (fe#211). A tick
      // held for it (`progress`) is replaced.
      AudiosiloPlayer.addListener('onRemoteMove', ({ trackIndex, position }) => {
        if (!Number.isFinite(trackIndex) || !Number.isFinite(position)) return;
        this.dropHeld();
        this.snapshot = { ...this.snapshot, trackIndex, position };
        this.lastTick =
          this.snapshot.state === 'playing' ? { position, trackIndex, at: Date.now() } : null;
        this.remoteMove?.(trackIndex, position);
        this.emit();
      }),
      AudiosiloPlayer.addListener('onRateChange', ({ rate }) => {
        if (!Number.isFinite(rate) || rate <= 0) return;
        this.update({ rate });
        this.rateChange?.(rate);
      }),
    );
    await AudiosiloPlayer.setup();
    this.setupDone = true;
  }

  async configure(config: PlaybackConfig) {
    // `smartSpeed` / `voiceBoost` ride along on every binary: the config is a record, and
    // a binary that predates the effects ignores fields it doesn't read.
    await AudiosiloPlayer.setConfig(config);
  }

  async load(
    tracks: PlaybackTrack[],
    startIndex: number,
    positionInTrack: number,
    chapters?: PlaybackChapter[],
    book?: BookRef,
  ) {
    // chapters are the per-chapter clips: Android builds clipped media items from them, iOS
    // drives its chapter lock screen with them. PlaybackChapter and NativeChapter are the
    // same shape, so they pass straight through. `book` goes only to a binary that takes it
    // (see `moduleTakesBook`).
    const native = tracks.map(toNativeTrack);
    if (book && moduleTakesBook()) {
      await AudiosiloPlayer.load(native, startIndex, positionInTrack, chapters ?? [], book);
    } else {
      await AudiosiloPlayer.load(native, startIndex, positionInTrack, chapters);
    }
    this.update({
      trackIndex: startIndex,
      position: positionInTrack,
      duration: tracks[startIndex]?.duration ?? 0,
      state: 'ready',
    });
  }

  async play() {
    await AudiosiloPlayer.play();
  }
  async pause() {
    await AudiosiloPlayer.pause();
  }
  async seekTo(positionInTrack: number) {
    await AudiosiloPlayer.seekTo(positionInTrack);
    this.update({ position: positionInTrack });
  }
  async skipToTrack(index: number, positionInTrack = 0) {
    await AudiosiloPlayer.skipToTrack(index, positionInTrack);
    this.update({ trackIndex: index, position: positionInTrack });
  }
  async setRate(rate: number) {
    await AudiosiloPlayer.setRate(rate);
    this.update({ rate });
  }
  async setVolume(volume: number) {
    // The JS bundle can be newer than the native binary it runs on: an installed dev
    // build, or a shipped App Store / Play build, that predates `setVolume`. Calling a
    // function a native module doesn't define THROWS, so an unguarded call would turn a
    // sleep-timer fade into a playback-breaking rejection on every older install.
    // Feature-detect, and still catch, so an old binary degrades to "no fade" and resolves.
    if (typeof AudiosiloPlayer.setVolume !== 'function') return;
    try {
      // Not re-clamped here: the store clamps every value on its way out (see
      // `PlaybackService.setVolume`), and the native side clamps again on the far
      // side of the bridge.
      await AudiosiloPlayer.setVolume(volume);
    } catch {
      // no volume control on this binary - silently keep playing at the current volume
    }
  }
  async reset() {
    await AudiosiloPlayer.reset();
    this.update({ ...INITIAL_SNAPSHOT, rate: this.snapshot.rate });
  }
  // The native picker is a system UI affordance, always available on iOS/Android.
  canShowRoutePicker() {
    return true;
  }
  async showRoutePicker() {
    return AudiosiloPlayer.showRoutePicker();
  }
  onRemoteMove(handler: ((trackIndex: number, positionInTrack: number) => void) | null) {
    this.remoteMove = handler;
  }
  onRateChange(handler: ((rate: number) => void) | null) {
    this.rateChange = handler;
  }
  onSilenceSaved(handler: ((totalSeconds: number) => void) | null) {
    this.silenceSaved = handler;
  }
  adoptPlace(snapshot: PlaybackSnapshot) {
    // No emit: the store sets its own snapshot when it adopts; this only makes the next
    // engine event (a progress tick carries no track or state) re-emit the right ones.
    this.dropHeld();
    this.lastTick = null;
    this.snapshot = { ...snapshot };
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
}

/** The store's one engine: this platform's, behind the Cast route switch (`routed`), which
 * hands playback to a Cast receiver while a session is connected and back after it. */
export function createPlaybackService(): PlaybackService {
  return routed(new NativePlaybackService());
}
