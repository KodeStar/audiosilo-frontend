import type { Book, ChaptersResponse } from '@/api/types';
import { isLoopbackHost, urlHost } from '@/lib/url-host';
import { isBrowserUndecodable, transcodeUrlAt } from '@/playback/transcode';
import type { BookRef, PlaybackTrack } from '@/playback/types';

import type { CastItem, CastMediaStatus } from './types';

/**
 * The pure rules of casting (no React, no native module, no network): what a Cast
 * receiver can play, which address it can reach, how a book's tracks become its queue,
 * and how the receiver's status maps back onto the store's per-track place.
 */

/**
 * ffprobe codec names the Default Media Receiver can't decode. It plays MP3, AAC in MP4,
 * Ogg Vorbis and Opus, FLAC and WAV (developers.google.com/cast/docs/media), not ALAC, WMA
 * or the AC-3 family. A book in one of these casts through the server's transcoder
 * (`?transcode=1`) when it has one.
 */
const CAST_UNPLAYABLE_CODECS: ReadonlySet<string> = new Set([
  'alac',
  'ac3',
  'eac3',
  'dts',
  'truehd',
  'wmav1',
  'wmav2',
  'wmapro',
  'wmalossless',
  'amr_nb',
  'amr_wb',
]);

/** Does this book need the server's transcoder to play on a Cast receiver? The server's own
 * `direct_playable: false` (a browser can't decode it, and the receiver is a browser), or a
 * codec the receiver is known not to play. The chapters response is preferred, as in
 * `isBrowserUndecodable`. */
export function castNeedsTranscode(
  book: Pick<Book, 'codec' | 'direct_playable'>,
  chapters?: Pick<ChaptersResponse, 'codec' | 'direct_playable'>,
): boolean {
  if (isBrowserUndecodable(book as Book, chapters as ChaptersResponse | undefined)) return true;
  const codec = (chapters?.codec || book.codec || '').trim().toLowerCase();
  return CAST_UNPLAYABLE_CODECS.has(codec);
}

/** Why a book can't go to a Cast receiver, or null when it can. */
export type CastBlockReason =
  /** The server has no `cast` capability (an older server). */
  | 'unsupported'
  /** The address the app uses is this device itself (`localhost`), which the receiver,
   * another device on the network, can't reach. */
  | 'local-address'
  /** The book's codec needs the server's transcoder, and the server has none. */
  | 'codec'
  /** The book's server connection is gone (a downloaded book whose sign-in failed). */
  | 'no-connection';

/**
 * Can a Cast receiver (another device on the network) fetch from this address? Not one
 * that means "this device" (`isLoopbackHost`). A relative or unparseable address can't be
 * handed over either.
 */
export function isReachableByReceiver(baseUrl: string): boolean {
  const host = urlHost(baseUrl);
  return host !== null && !isLoopbackHost(host);
}

/**
 * Whether casting this book is blocked, given what is known: the server's flags (`cast`,
 * `transcode`; undefined = unknown, which blocks nothing here), the address the app reaches
 * the server at, and the book (when known). The one rule the Cast button and the cast
 * engine share.
 */
export function castBlockReason(input: {
  canCast: boolean | undefined;
  canTranscode: boolean | undefined;
  baseUrl: string | null;
  book?: Pick<Book, 'codec' | 'direct_playable'> | null;
  chapters?: Pick<ChaptersResponse, 'codec' | 'direct_playable'> | null;
}): CastBlockReason | null {
  if (input.baseUrl === null) return 'no-connection';
  if (input.canCast === false) return 'unsupported';
  if (!isReachableByReceiver(input.baseUrl)) return 'local-address';
  if (
    input.book &&
    input.canTranscode === false &&
    castNeedsTranscode(input.book, input.chapters ?? undefined)
  ) {
    return 'codec';
  }
  return null;
}

/** MIME type for a book file by its extension. The Default Media Receiver needs it to pick
 * a decoder (`audio/mp4` for every MP4 family file: m4a, m4b, mp4, aac in MP4). A transcoded
 * stream is always MP3. */
export function castContentType(path: string, transcoded = false): string {
  if (transcoded) return 'audio/mpeg';
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  switch (ext) {
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
    case 'm4b':
    case 'mp4':
    case 'aac':
      return 'audio/mp4';
    case 'ogg':
    case 'oga':
    case 'opus':
      return 'audio/ogg';
    case 'flac':
      return 'audio/flac';
    case 'wav':
      return 'audio/wav';
    case 'webm':
      return 'audio/webm';
    default:
      return 'audio/mpeg';
  }
}

/** The book file a track plays: `buildBookQueue` names every track `${libraryId}:${path}`
 * (the library id is a number, so the first `:` ends it; a path may contain more). */
export function trackFilePath(track: Pick<PlaybackTrack, 'id'>): string {
  const i = track.id.indexOf(':');
  return i < 0 ? track.id : track.id.slice(i + 1);
}

/** What `buildCastItems` needs to know about where the receiver fetches from: the URL
 * builders of a client that carries the CAST token (never the session token). */
export type CastUrls = {
  streamUrl(
    libraryId: number,
    path: string,
    download?: boolean,
    opts?: { transcode?: boolean },
  ): string;
  coverUrl(libraryId: number, path: string): string;
};

/**
 * The receiver's queue for a book: one item per track, in the store's track order (so a
 * queue index IS a track index), each a stream URL built with the cast token, its MIME
 * type, its known duration and the book's display metadata, plus the book's cover (also
 * with the cast token: a local `file://` cover would be unreachable). `transcode` streams
 * every file through the server's transcoder.
 */
export function buildCastItems(
  tracks: PlaybackTrack[],
  book: BookRef,
  urls: CastUrls,
  transcode: boolean,
): CastItem[] {
  const cover = urls.coverUrl(book.libraryId, book.path);
  return tracks.map((t, index) => {
    const path = trackFilePath(t);
    return {
      index,
      url: urls.streamUrl(book.libraryId, path, false, transcode ? { transcode: true } : undefined),
      contentType: castContentType(path, transcode),
      duration: t.duration && t.duration > 0 ? t.duration : undefined,
      title: t.title,
      artist: t.artist || undefined,
      album: t.album || undefined,
      cover,
      transcoded: transcode,
    };
  });
}

/**
 * A transcoded item can't be seeked by the receiver (the stream has no byte ranges), so a
 * start or a seek inside one asks for the stream from that point (`&t=`, `transcodeUrlAt`)
 * and the receiver's clock then counts from there. Returns the item to send and the
 * file position its time 0 stands for (0 for a direct stream, which the receiver seeks).
 */
export function itemStartingAt(
  item: CastItem,
  position: number,
): { item: CastItem; offset: number } {
  if (!item.transcoded || !(position > 0)) return { item, offset: 0 };
  const t = item.duration ? Math.min(position, Math.max(0, item.duration - 1)) : position;
  return {
    item: {
      ...item,
      url: transcodeUrlAt(item.url, t),
      duration: item.duration ? Math.max(0, item.duration - t) : undefined,
    },
    offset: t,
  };
}

/**
 * Which track the receiver is on, from its status: the current item's own `contentId` (its
 * URL, matched against what was sent: a transcoded item's `&t=` is ignored), else the
 * index we put in the item's `customData`, else the current item's place among the queue's
 * item ids (the receiver keeps the order it was given). Null when none of these says.
 */
export function castTrackIndex(status: CastMediaStatus, sentUrls: string[]): number | null {
  const strip = (u: string) => transcodeUrlAt(u, 0);
  if (status.contentId) {
    const want = strip(status.contentId);
    const i = sentUrls.findIndex((u) => strip(u) === want);
    if (i >= 0) return i;
  }
  if (
    typeof status.customIndex === 'number' &&
    status.customIndex >= 0 &&
    status.customIndex < sentUrls.length
  ) {
    return status.customIndex;
  }
  if (status.currentItemId != null && status.queueItemIds && status.queueItemIds.length > 0) {
    const i = status.queueItemIds.indexOf(status.currentItemId);
    if (i >= 0 && i < sentUrls.length) return i;
  }
  return null;
}

/** A place on the receiver as last seen: the track, the position in it, when, and whether it
 * was playing at what speed (to extrapolate where it should be now). */
export type SeenPlace = {
  trackIndex: number;
  position: number;
  at: number;
  playing: boolean;
  rate: number;
};

/** How far (seconds) the receiver may be from where it should be before it counts as moved. */
const JUMP_TOLERANCE_S = 5;

/**
 * Did the receiver move by itself (the TV remote, Google Home, the Cast notification, another
 * sender) between two sightings? Same track: further than `JUMP_TOLERANCE_S` from where
 * playing on at `rate` puts it. Next track: only a natural run-on when the new position is
 * no further in than the time that passed. Any other track change is a move. The caller
 * skips this while a move it asked for is landing.
 */
export function isUnaskedJump(
  prev: SeenPlace | null,
  next: { trackIndex: number; position: number; at: number },
): boolean {
  if (!prev) return false;
  const elapsed = Math.max(0, (next.at - prev.at) / 1000) * (prev.playing ? prev.rate : 0);
  if (next.trackIndex === prev.trackIndex) {
    return Math.abs(next.position - (prev.position + elapsed)) > JUMP_TOLERANCE_S;
  }
  if (next.trackIndex === prev.trackIndex + 1) return next.position > elapsed + JUMP_TOLERANCE_S;
  return true;
}
