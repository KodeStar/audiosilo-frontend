import type { EventSubscription } from 'expo-modules-core';

import AudiosiloPlayer, { type NativeTrack } from '../../modules/audiosilo-player';

import {
  INITIAL_SNAPSHOT,
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

/**
 * Native playback via the local `audiosilo-player` module (AVQueuePlayer on iOS,
 * Media3/ExoPlayer on Android). The module handles background audio, gapless
 * multi-file playback, lock-screen controls + remote commands, and pitch-corrected
 * speed. The whole-book timeline lives in the player store; this engine works
 * per-track. The module's `NativeState` values match `PlaybackState` 1:1.
 */
class NativePlaybackService implements PlaybackService {
  private snapshot: PlaybackSnapshot = { ...INITIAL_SNAPSHOT };
  private listeners = new Set<(s: PlaybackSnapshot) => void>();
  private subscriptions: EventSubscription[] = [];
  private setupDone = false;

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
      AudiosiloPlayer.addListener('onProgress', ({ position, duration }) =>
        this.update({ position, duration }),
      ),
      AudiosiloPlayer.addListener('onTrackChange', ({ index }) =>
        this.update({ trackIndex: index }),
      ),
    );
    await AudiosiloPlayer.setup();
    this.setupDone = true;
  }

  async configure(config: PlaybackConfig) {
    await AudiosiloPlayer.setConfig(config);
  }

  async load(tracks: PlaybackTrack[], startIndex: number, positionInTrack: number) {
    await AudiosiloPlayer.load(tracks.map(toNativeTrack), startIndex, positionInTrack);
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
  async reset() {
    await AudiosiloPlayer.reset();
    this.update({ ...INITIAL_SNAPSHOT, rate: this.snapshot.rate });
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
