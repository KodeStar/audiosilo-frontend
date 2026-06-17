export type PlaybackTrack = {
  id: string;
  url: string;
  /** Auth headers for native engines (track-player); web uses ?token= in the URL. */
  headers?: Record<string, string>;
  title: string;
  album?: string;
  artist?: string;
  artwork?: string;
  /** Track duration in seconds, if known. */
  duration?: number;
};

export type PlaybackState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error';

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

/**
 * Platform-agnostic playback engine. Implemented by track-player on native and
 * HTML5 Audio on web; the player store talks only to this interface so the
 * engine stays swappable.
 */
export interface PlaybackService {
  setup(): Promise<void>;
  load(tracks: PlaybackTrack[], startIndex: number, positionInTrack: number): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  /** Seek within the current track. */
  seekTo(positionInTrack: number): Promise<void>;
  skipToTrack(index: number, positionInTrack?: number): Promise<void>;
  setRate(rate: number): Promise<void>;
  reset(): Promise<void>;
  getSnapshot(): PlaybackSnapshot;
  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void;
}
