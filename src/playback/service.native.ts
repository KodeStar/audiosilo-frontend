import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  Event,
  State,
  type Track,
} from 'react-native-track-player';

import { INITIAL_SNAPSHOT, type PlaybackService, type PlaybackSnapshot, type PlaybackTrack } from './types';

function toRNTPTrack(t: PlaybackTrack): Track {
  return {
    id: t.id,
    url: t.url,
    headers: t.headers,
    title: t.title,
    artist: t.artist,
    album: t.album,
    artwork: t.artwork,
    duration: t.duration,
  };
}

function mapState(state: State): PlaybackSnapshot['state'] {
  switch (state) {
    case State.Playing:
      return 'playing';
    case State.Paused:
    case State.Stopped:
      return 'paused';
    case State.Ready:
      return 'ready';
    case State.Buffering:
    case State.Loading:
      return 'loading';
    case State.Ended:
      return 'ended';
    case State.Error:
      return 'error';
    default:
      return 'idle';
  }
}

/**
 * Native playback via react-native-track-player (background audio, lock-screen /
 * Control Center metadata + remote commands). The whole-book timeline lives in
 * the player store; this engine works per-track.
 */
class NativePlaybackService implements PlaybackService {
  private snapshot: PlaybackSnapshot = { ...INITIAL_SNAPSHOT };
  private listeners = new Set<(s: PlaybackSnapshot) => void>();
  private rate = 1;
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
    await TrackPlayer.setupPlayer({ autoHandleInterruptions: true });
    await TrackPlayer.updateOptions({
      android: {
        appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
      },
      capabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.SeekTo,
        Capability.JumpForward,
        Capability.JumpBackward,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
      ],
      notificationCapabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.JumpForward,
        Capability.JumpBackward,
      ],
      forwardJumpInterval: 30,
      backwardJumpInterval: 15,
      progressUpdateEventInterval: 1,
    });

    TrackPlayer.addEventListener(Event.PlaybackState, (e) => this.update({ state: mapState(e.state) }));
    TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, (e) =>
      this.update({ position: e.position, duration: e.duration }),
    );
    TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, (e) => {
      if (typeof e.index === 'number') this.update({ trackIndex: e.index });
    });
    this.setupDone = true;
  }

  async load(tracks: PlaybackTrack[], startIndex: number, positionInTrack: number) {
    await TrackPlayer.reset();
    await TrackPlayer.add(tracks.map(toRNTPTrack));
    if (startIndex > 0) await TrackPlayer.skip(startIndex);
    if (positionInTrack > 0) await TrackPlayer.seekTo(positionInTrack);
    await TrackPlayer.setRate(this.rate);
    this.update({
      trackIndex: startIndex,
      position: positionInTrack,
      duration: tracks[startIndex]?.duration ?? 0,
      state: 'ready',
    });
  }

  async play() {
    await TrackPlayer.play();
  }
  async pause() {
    await TrackPlayer.pause();
  }
  async seekTo(positionInTrack: number) {
    await TrackPlayer.seekTo(positionInTrack);
    this.update({ position: positionInTrack });
  }
  async skipToTrack(index: number, positionInTrack = 0) {
    await TrackPlayer.skip(index);
    if (positionInTrack > 0) await TrackPlayer.seekTo(positionInTrack);
    this.update({ trackIndex: index, position: positionInTrack });
  }
  async setRate(rate: number) {
    this.rate = rate;
    await TrackPlayer.setRate(rate);
    this.update({ rate });
  }
  async reset() {
    await TrackPlayer.reset();
    this.update({ ...INITIAL_SNAPSHOT, rate: this.rate });
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
