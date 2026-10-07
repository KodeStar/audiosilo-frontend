import * as Sharing from 'expo-sharing';
import type { View } from 'react-native';
import { captureRef } from 'react-native-view-shot';

/** The size of a shared card: a 9:16 story image, as the story apps take it. */
export const SHARE_WIDTH = 1080;
export const SHARE_HEIGHT = 1920;

export type ShareCardOptions = {
  /** The PNG's file name (`audiosilo-2026-1-hours.png`). */
  fileName: string;
  /** The share sheet's title (Android) / the shared item's title (web). */
  title: string;
};

/** What a share did: the share sheet opened (and closed), or (web) the PNG downloaded. */
export type ShareOutcome = 'shared' | 'downloaded';

/** A captured card: a PNG file's URI (native) or the PNG itself (web). */
export type CapturedCard = string | Blob;

/**
 * Native: capture the rendered card (`view`, the same component the story shows) to a
 * 1080 x 1920 PNG in the cache with react-native-view-shot. Rejects when the capture
 * fails (the caller can retry without covers: see `useShareCard`). The web build has its
 * own module (`share-card.web.ts`: html2canvas, then the Web Share API or a download).
 */
export function captureCard(view: View, fileName: string): Promise<CapturedCard> {
  return captureRef(view, {
    format: 'png',
    quality: 1,
    width: SHARE_WIDTH,
    height: SHARE_HEIGHT,
    result: 'tmpfile',
    fileName: fileName.replace(/\.png$/, ''),
  });
}

/** Native: open the share sheet on a captured card (`expo-sharing`). Resolves once the
 * sheet closes, shared or not. */
export async function deliverCard(
  card: CapturedCard,
  opts: ShareCardOptions,
): Promise<ShareOutcome> {
  await Sharing.shareAsync(card as string, {
    mimeType: 'image/png',
    UTI: 'public.png',
    dialogTitle: opts.title,
  });
  return 'shared';
}
