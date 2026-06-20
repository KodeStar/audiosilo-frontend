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

  /** Create an <audio> with all listeners wired. Each listener no-ops unless its
   * element is the active one, so a buffering element being prepared by `swapTo`
   * can't drive the snapshot until we switch to it. */
  private createAudio(): HTMLAudioElement {
    const a = new Audio();
    a.preload = 'auto';
    const active = () => a === this.audio;
    a.addEventListener('timeupdate', () => active() && this.update({ position: a.currentTime }));
    a.addEventListener('durationchange', () => {
      if (active() && Number.isFinite(a.duration)) this.update({ duration: a.duration });
    });
    a.addEventListener('playing', () => active() && this.update({ state: 'playing' }));
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

  async swapTo(
    tracks: PlaybackTrack[],
    startIndex: number,
    positionInTrack: number,
  ): Promise<boolean> {
    const track = tracks[startIndex];
    if (!track) return false;

    // Downloaded files live behind synthetic `…/_offline/…` urls that only resolve
    // when our service worker is controlling this page (it serves them from the
    // Cache API). If it isn't — unsupported, registration delayed/failed, or a
    // non-PWA first load that hasn't been claimed yet — the url 404s. Switching to a
    // dead source would stop playback with no way to resume, so refuse the swap and
    // keep streaming; a later open of the book will pick up the local copy.
    if (
      track.url.includes('/_offline/') &&
      !(typeof navigator !== 'undefined' && navigator.serviceWorker?.controller)
    ) {
      return false;
    }

    const wasPlaying = this.snapshot.state === 'playing';

    // Buffer the new (local) source on a separate element while the current one
    // keeps playing, then switch — so there's no silent gap while it loads/seeks.
    const pending = this.createAudio();
    pending.src = track.url;
    pending.playbackRate = this.rate;
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
        try {
          pending.currentTime = positionInTrack || 0;
        } catch {
          // can't seek yet; the readiness check below retries via `seeked`
        }
      };
      // Ready once it can play AND the playhead is at the seek target.
      const onReady = () => {
        if (pending.readyState >= 3 && Math.abs(pending.currentTime - (positionInTrack || 0)) < 1.5)
          done(true);
      };
      const onError = () => done(false);
      pending.addEventListener('loadedmetadata', onLoaded);
      pending.addEventListener('canplay', onReady);
      pending.addEventListener('seeked', onReady);
      pending.addEventListener('error', onError);
      pending.load();
      setTimeout(() => done(false), 8000); // never hang; a slow load counts as a failed swap
    });

    // The local source never became playable — discard it and keep streaming rather
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
    if (old) {
      old.pause();
      old.removeAttribute('src');
      old.load();
    }
    this.setMediaSession(track);
    this.update({
      trackIndex: startIndex,
      position: positionInTrack,
      duration: track.duration ?? (Number.isFinite(pending.duration) ? pending.duration : 0),
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
      navigator.mediaSession.setActionHandler(
        'seekbackward',
        () => void this.seekTo(Math.max(0, this.snapshot.position - this.config.jumpBackward)),
      );
      navigator.mediaSession.setActionHandler(
        'seekforward',
        () => void this.seekTo(this.snapshot.position + this.config.jumpForward),
      );
    } catch {
      // unsupported action handlers; ignore
    }
  }
}

export function createPlaybackService(): PlaybackService {
  return new WebPlaybackService();
}
