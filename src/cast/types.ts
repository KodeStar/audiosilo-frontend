import type { BookRef } from '@/playback/types';

/**
 * The Cast seam: what the app needs from a Cast sender SDK, in our words. Two drivers
 * implement it (`driver.native.ts` over react-native-google-cast, `driver.web.ts` over the
 * Cast Web Sender); everything above it (the cast engine, the route switch, the session
 * glue) is shared and tested against fakes.
 */

/** One file of a book as the receiver plays it. `index` is its track index in the store's
 * queue (sent in the item's `customData` so the status can name it back). */
export type CastItem = {
  index: number;
  url: string;
  contentType: string;
  duration?: number;
  title: string;
  artist?: string;
  album?: string;
  cover?: string;
  /** Streamed through the server's transcoder (not seekable by the receiver). */
  transcoded: boolean;
};

/** A queue load: the items, where to start, at what speed, and the book it is (in the
 * items' `customData`, so a sender that reconnects later can tell what is playing). */
export type CastQueueLoad = {
  items: CastItem[];
  startIndex: number;
  /** Seconds into the start item (0 for a transcoded item already requested at its place). */
  startTime: number;
  rate: number;
  autoplay: boolean;
  book: BookRef;
  /** The book's title and cover for the queue's container metadata. */
  title: string;
};

/** The receiver's player state (the Cast `MediaPlayerState`, lower-case). */
export type CastPlayerState = 'idle' | 'loading' | 'buffering' | 'playing' | 'paused';
/** Why the receiver is idle (`MediaPlayerIdleReason`). */
export type CastIdleReason = 'finished' | 'error' | 'cancelled' | 'interrupted';

/** The receiver's media status, as much of it as the app reads. */
export type CastMediaStatus = {
  playerState: CastPlayerState;
  idleReason?: CastIdleReason | null;
  /** The current item's content id (we send its URL). */
  contentId?: string | null;
  /** `customData.index` of the current item, when the receiver echoes it. */
  customIndex?: number | null;
  currentItemId?: number | null;
  /** The queue's item ids in order, when the status carries them. */
  queueItemIds?: number[];
  /** Seconds into the current item, as the receiver counts them. */
  position: number;
  rate: number;
  /** The book named in the current item's `customData` (ours), else null. */
  book?: BookRef | null;
};

/** The media controls of one connected Cast session. */
export interface CastRemote {
  load(request: CastQueueLoad): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  /** Seek within the current item. */
  seek(position: number): Promise<void>;
  setRate(rate: number): Promise<void>;
  /** Stop the receiver's media (the session stays connected). */
  stop(): Promise<void>;
  /** A fresh status read, bounded in time (the Android SDK's getters can hang); null when
   * there is none to be had. */
  readStatus(): Promise<CastMediaStatus | null>;
  /** The receiver's status whenever it changes (null: no media). Returns the unsubscribe. */
  onStatus(handler: (status: CastMediaStatus | null) => void): () => void;
  /** The current item's position about once a second while there is media. */
  onProgress(handler: (position: number) => void): () => void;
}

/** A Cast session's life, as the drivers report it. `resumed` is a session that was already
 * running: the app came back from the background (iOS suspends the sender there), or it was
 * relaunched while the TV kept playing. */
export type CastSessionEvent =
  | { type: 'starting' }
  | { type: 'started' | 'resumed'; remote: CastRemote; deviceName?: string }
  | { type: 'startFailed'; error?: string }
  | { type: 'suspended' }
  | { type: 'ending' }
  | { type: 'ended'; error?: string };

/** A Cast sender SDK: whether it can work here, its session events and controls. */
export interface CastDriver {
  /** Whether casting can work on this device at all (the native module is in this binary
   * and, on Android, Google Play services are there; the web: Chromium in a secure
   * context). Never loads anything. */
  supported(): Promise<boolean>;
  /** Make the SDK ready (the web loads the sender script here, once). Resolves whether it
   * is. */
  init(): Promise<boolean>;
  /** Session events. Returns the unsubscribe. */
  subscribe(handler: (event: CastSessionEvent) => void): () => void;
  /** The session already connected when the app started listening, if any. */
  current(): Promise<{ remote: CastRemote; deviceName?: string } | null>;
  /** Leave the session; `stopCasting` also stops the receiver's media. */
  endSession(stopCasting: boolean): Promise<void>;
  /** Web only: open the browser's Cast chooser (native uses the SDK's own Cast button). */
  requestSession?(): Promise<void>;
}
