/// <reference lib="dom" />
import {
  INITIAL_SNAPSHOT,
  type PlaybackConfig,
  type PlaybackService,
  type PlaybackSnapshot,
  type PlaybackTrack,
} from './types';

/**
 * Web playback via a single HTML5 <audio> element. The token is already in the
 * track URL (query param), so Range requests (seek/scrub) work natively. The
 * queue is advanced manually on `ended`. Media Session API wires up OS / browser
 * lock-screen transport controls.
 */
class WebPlaybackService implements PlaybackService {
  private audio: HTMLAudioElement | null = null;
  private tracks: PlaybackTrack[] = [];
  private index = 0;
  private rate = 1;
  private config: PlaybackConfig = { autoRewindMax: 0, jumpForward: 30, jumpBackward: 15 };
  private pausedAt: number | null = null;
  private snapshot: PlaybackSnapshot = { ...INITIAL_SNAPSHOT };
  private listeners = new Set<(s: PlaybackSnapshot) => void>();

  private emit() {
    for (const listener of this.listeners) listener(this.snapshot);
  }
  private update(patch: Partial<PlaybackSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private el(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const a = new Audio();
    a.preload = 'auto';
    a.addEventListener('timeupdate', () => this.update({ position: a.currentTime }));
    a.addEventListener('durationchange', () => {
      if (Number.isFinite(a.duration)) this.update({ duration: a.duration });
    });
    a.addEventListener('playing', () => this.update({ state: 'playing' }));
    a.addEventListener('pause', () => {
      if (this.snapshot.state !== 'ended') this.update({ state: 'paused' });
    });
    a.addEventListener('waiting', () => this.update({ state: 'loading' }));
    a.addEventListener('ended', () => this.handleEnded());
    a.addEventListener('error', () => this.update({ state: 'error' }));
    this.audio = a;
    return a;
  }

  private loadTrack(index: number, positionInTrack: number, autoplay: boolean) {
    const track = this.tracks[index];
    if (!track) return;
    const a = this.el();
    this.index = index;
    a.src = track.url;
    a.playbackRate = this.rate;
    this.update({
      trackIndex: index,
      position: positionInTrack,
      duration: track.duration ?? 0,
      state: 'loading',
    });
    this.setMediaSession(track);
    const onLoaded = () => {
      a.removeEventListener('loadedmetadata', onLoaded);
      try {
        a.currentTime = positionInTrack || 0;
      } catch {
        // seeking before ready; timeupdate will correct
      }
      if (autoplay) void a.play();
    };
    a.addEventListener('loadedmetadata', onLoaded);
    a.load();
  }

  private handleEnded() {
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

  async load(tracks: PlaybackTrack[], startIndex: number, positionInTrack: number) {
    this.tracks = tracks;
    this.loadTrack(startIndex, positionInTrack, false);
    this.update({ state: 'ready' });
  }

  async play() {
    const a = this.el();
    if (this.config.autoRewindMax > 0 && this.pausedAt != null) {
      const rewind = Math.min(this.config.autoRewindMax, (Date.now() - this.pausedAt) / 1000);
      if (rewind > 0.5) a.currentTime = Math.max(0, a.currentTime - rewind);
    }
    this.pausedAt = null;
    await a.play();
  }

  async pause() {
    this.el().pause();
    this.pausedAt = Date.now();
  }

  async seekTo(positionInTrack: number) {
    this.el().currentTime = positionInTrack;
    this.update({ position: positionInTrack });
  }

  async skipToTrack(index: number, positionInTrack = 0) {
    const wasPlaying = this.snapshot.state === 'playing';
    this.loadTrack(index, positionInTrack, wasPlaying);
  }

  async setRate(rate: number) {
    this.rate = rate;
    if (this.audio) this.audio.playbackRate = rate;
    this.update({ rate });
  }

  async reset() {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    this.tracks = [];
    this.index = 0;
    this.snapshot = { ...INITIAL_SNAPSHOT, rate: this.rate };
    this.emit();
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
        void this.seekTo(Math.max(0, this.snapshot.position - this.config.jumpBackward)),
      );
      navigator.mediaSession.setActionHandler('seekforward', () =>
        void this.seekTo(this.snapshot.position + this.config.jumpForward),
      );
    } catch {
      // unsupported action handlers; ignore
    }
  }
}

export function createPlaybackService(): PlaybackService {
  return new WebPlaybackService();
}
