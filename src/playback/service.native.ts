import type { EventSubscription } from 'expo-modules-core';

import AudiosiloPlayer, { type NativeTrack } from '../../modules/audiosilo-player';

import {
  type BookRef,
  INITIAL_SNAPSHOT,
  type PlaybackChapter,
  type PlaybackConfig,
  type PlaybackService,
  type PlaybackSnapshot,
  type PlaybackTrack,
} from './types';

function toNativeTrack(t: PlaybackTrack): NativeTrack {
  return {
    id: t.id,
    url: t.url,
    headers: t.headers,
    title: t.title,
    album: t.album,
    artist: t.artist,
    artwork: t.artwork,
    duration: t.duration,
  };
}

/** Does the installed binary know Phase 6's module surface (`load`'s 5th `book` argument
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
 * Phase 6 events (`onRemoteMove`, `onRateChange`, `onRemoteBookmark`, `silenceSaved` on
 * `onProgress`) are listened for on every binary: an older one simply never sends them,
 * and listening for an event a module doesn't declare is harmless.
 */
class NativePlaybackService implements PlaybackService {
  private snapshot: PlaybackSnapshot = { ...INITIAL_SNAPSHOT };
  private listeners = new Set<(s: PlaybackSnapshot) => void>();
  private subscriptions: EventSubscription[] = [];
  private setupDone = false;
  private remoteMove: ((trackIndex: number, positionInTrack: number) => void) | null = null;
  private rateChange: ((rate: number) => void) | null = null;
  private remoteBookmark: ((trackIndex: number, positionInTrack: number) => void) | null = null;
  private silenceSaved: ((totalSeconds: number) => void) | null = null;

  private emit() {
    for (const listener of this.listeners) listener(this.snapshot);
  }
  private update(patch: Partial<PlaybackSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  async setup() {
    if (this.setupDone) return;
    this.subscriptions.push(
      AudiosiloPlayer.addListener('onState', ({ state }) => this.update({ state })),
      AudiosiloPlayer.addListener('onProgress', ({ position, duration, silenceSaved }) => {
        this.update({ position, duration });
        // Absent on binaries older than Smart Speed.
        if (typeof silenceSaved === 'number' && Number.isFinite(silenceSaved)) {
          this.silenceSaved?.(silenceSaved);
        }
      }),
      AudiosiloPlayer.addListener('onTrackChange', ({ index }) =>
        this.update({ trackIndex: index }),
      ),
      // The engine already moved (the lock screen, a headset, the car): take the landed
      // place into the snapshot FIRST, so the store's save inside the handler saves it.
      AudiosiloPlayer.addListener('onRemoteMove', ({ trackIndex, position }) => {
        if (!Number.isFinite(trackIndex) || !Number.isFinite(position)) return;
        this.update({ trackIndex, position });
        this.remoteMove?.(trackIndex, position);
      }),
      AudiosiloPlayer.addListener('onRateChange', ({ rate }) => {
        if (!Number.isFinite(rate) || rate <= 0) return;
        this.update({ rate });
        this.rateChange?.(rate);
      }),
      AudiosiloPlayer.addListener('onRemoteBookmark', ({ trackIndex, position }) => {
        if (!Number.isFinite(trackIndex) || !Number.isFinite(position)) return;
        this.remoteBookmark?.(trackIndex, position);
      }),
    );
    await AudiosiloPlayer.setup();
    this.setupDone = true;
  }

  async configure(config: PlaybackConfig) {
    // `smartSpeed` / `voiceBoost` ride along on every binary: the config is a record, and
    // one older than Phase 6 ignores fields it doesn't read.
    await AudiosiloPlayer.setConfig(config);
  }

  async load(
    tracks: PlaybackTrack[],
    startIndex: number,
    positionInTrack: number,
    chapters?: PlaybackChapter[],
    book?: BookRef,
  ) {
    // chapters are the per-chapter clips; the Android module builds clipped media items
    // from them (iOS ignores the arg). PlaybackChapter and NativeChapter are the same
    // shape, so they pass straight through. `book` goes only to a binary that takes it
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
  onRemoteBookmark(handler: ((trackIndex: number, positionInTrack: number) => void) | null) {
    this.remoteBookmark = handler;
  }
  onSilenceSaved(handler: ((totalSeconds: number) => void) | null) {
    this.silenceSaved = handler;
  }
  adoptPlace(snapshot: PlaybackSnapshot) {
    // No emit: the store sets its own snapshot when it adopts; this only makes the next
    // engine event (a progress tick carries no track or state) re-emit the right ones.
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

export function createPlaybackService(): PlaybackService {
  return new NativePlaybackService();
}
