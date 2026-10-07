/** What the share pipeline (`share-card.ts` native, `share-card.web.ts` web) agrees on. */

/** The size of a shared card: a 9:16 story image, as the story apps take it. */
export const SHARE_WIDTH = 1080;
export const SHARE_HEIGHT = 1920;

export type ShareCardOptions = {
  /** The PNG's file name (`audiosilo-2026-01-hours.png`). */
  fileName: string;
  /** The share sheet's title (Android) / the shared item's title (web). */
  title: string;
};

/** What a share did: the share sheet opened (and closed), or (web) the PNG downloaded. */
export type ShareOutcome = 'shared' | 'downloaded';

/** A captured card: a PNG file's URI (native) or the PNG itself (web). */
export type CapturedCard = string | Blob;
