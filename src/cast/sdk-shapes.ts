import type { BookRef } from '@/playback/types';

import type {
  CastIdleReason,
  CastItem,
  CastMediaStatus,
  CastPlayerState,
  CastQueueLoad,
} from './types';

/**
 * The Cast SDKs' JSON, built and read in one pure place (both drivers use it, and the tests
 * pin it): the load request react-native-google-cast takes (its `MediaLoadRequest`, which the
 * Android and iOS bridges turn into `MediaLoadRequestData` / `GCKMediaLoadRequestData`), and
 * their media status read back as ours.
 *
 * NO key is ever `undefined`: the native bridges test `hasKey` and then read the value as a
 * number or string, so a key present with no value would crash the Android conversion.
 */

type Json = Record<string, unknown>;

/** Copy `obj` without its undefined values (see the module comment). */
function defined<T extends Json>(obj: T): Partial<T> {
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/** The custom data every item carries: its track index and the book, so a status (and a
 * sender that reconnects later) can say what is playing. */
export function itemCustomData(item: CastItem, book: BookRef): Json {
  return {
    index: item.index,
    connectionId: book.connectionId,
    libraryId: book.libraryId,
    path: book.path,
  };
}

/** A queue item's media information (`MediaInfo`): the stream URL as both content id and
 * content URL (newer receivers read the URL; the id is what the status echoes back), a
 * buffered (not live) stream, and music-track metadata so the TV shows the book. */
export function mediaInfoOf(item: CastItem, book: BookRef): Json {
  return defined({
    contentId: item.url,
    contentUrl: item.url,
    contentType: item.contentType,
    streamType: 'buffered',
    streamDuration: item.duration,
    customData: itemCustomData(item, book),
    metadata: defined({
      type: 'musicTrack',
      title: item.title,
      artist: item.artist,
      albumTitle: item.album,
      images: item.cover ? [{ url: item.cover }] : undefined,
    }),
  });
}

/** The load request for react-native-google-cast's `RemoteMediaClient.loadMedia`: the whole
 * book as an audiobook queue starting at `(startIndex, startTime)`. */
export function nativeLoadRequest(load: CastQueueLoad): Json {
  const items = load.items.map((item) =>
    defined({
      mediaInfo: mediaInfoOf(item, load.book),
      autoplay: true,
      preloadTime: 10,
      customData: itemCustomData(item, load.book),
    }),
  );
  const cover = load.items[0]?.cover;
  const total = load.items.reduce((sum, i) => sum + (i.duration ?? 0), 0);
  return {
    autoplay: load.autoplay,
    playbackRate: load.rate,
    queueData: defined({
      items,
      startIndex: load.startIndex,
      startTime: load.startTime,
      type: 'audioBook',
      repeatMode: 'off',
      containerMetadata: defined({
        containerType: 'audioBook',
        title: load.title || undefined,
        containerDuration: total > 0 ? total : undefined,
        containerImages: cover ? [{ url: cover }] : undefined,
      }),
    }),
  };
}

const PLAYER_STATES: ReadonlySet<string> = new Set([
  'idle',
  'loading',
  'buffering',
  'playing',
  'paused',
]);
const IDLE_REASONS: ReadonlySet<string> = new Set([
  'finished',
  'error',
  'cancelled',
  'interrupted',
]);

/** Our book from an item's custom data, when it is ours. */
function bookOfCustomData(data: unknown): BookRef | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Json;
  if (
    typeof d.connectionId === 'string' &&
    typeof d.libraryId === 'number' &&
    typeof d.path === 'string'
  ) {
    return { connectionId: d.connectionId, libraryId: d.libraryId, path: d.path };
  }
  return null;
}

/** The status fields both SDKs share (react-native-google-cast's `MediaStatus`, the web's
 * `chrome.cast.media.Media`), as loosely typed as they arrive. */
export type SdkStatus = {
  playerState?: string | null;
  idleReason?: string | null;
  currentItemId?: number | null;
  playbackRate?: number | null;
  streamPosition?: number | null;
  queueItems?: { itemId?: number | null }[] | null;
  mediaInfo?: {
    contentId?: string | null;
    contentUrl?: string | null;
    customData?: unknown;
  } | null;
};

/** Read an SDK status as ours (null: no media). The state and reason arrive in any case
 * (the native bridges send lower case, the web SDK upper case). */
export function fromSdkStatus(s: SdkStatus | null | undefined): CastMediaStatus | null {
  if (!s) return null;
  const state = (s.playerState ?? '').toLowerCase();
  const reason = (s.idleReason ?? '').toLowerCase();
  const custom = s.mediaInfo?.customData as Json | null | undefined;
  const ids = (s.queueItems ?? [])
    .map((i) => i.itemId)
    .filter((id): id is number => typeof id === 'number');
  return {
    playerState: (PLAYER_STATES.has(state) ? state : 'idle') as CastPlayerState,
    idleReason: IDLE_REASONS.has(reason) ? (reason as CastIdleReason) : null,
    contentId: s.mediaInfo?.contentUrl || s.mediaInfo?.contentId || null,
    customIndex: typeof custom?.index === 'number' ? custom.index : null,
    currentItemId: typeof s.currentItemId === 'number' ? s.currentItemId : null,
    queueItemIds: ids.length > 0 ? ids : undefined,
    position: Number.isFinite(s.streamPosition) ? (s.streamPosition as number) : NaN,
    rate: s.playbackRate && s.playbackRate > 0 ? s.playbackRate : 1,
    book: bookOfCustomData(custom),
  };
}

/**
 * A status read with the receiver's place as of NOW. A native SDK status holds the
 * position of the receiver's last status message, and a receiver that simply plays sends
 * none (iOS asks every 10 s, Android never), so that position can be minutes or hours old;
 * the SDK's approximate stream position (`live`) is it plus the time since, at the
 * receiver's speed. Used while the media plays or buffers. A live 0 or none (a session
 * already gone) keeps the status' own.
 */
export function withLivePosition(
  status: CastMediaStatus | null,
  live: number | null | undefined,
): CastMediaStatus | null {
  if (!status || (status.playerState !== 'playing' && status.playerState !== 'buffering')) {
    return status;
  }
  if (typeof live !== 'number' || !Number.isFinite(live) || live <= 0) return status;
  return { ...status, position: live };
}
