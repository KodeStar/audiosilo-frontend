import * as Sharing from 'expo-sharing';
import { PixelRatio, Platform, type View } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import {
  type CapturedCard,
  SHARE_HEIGHT,
  SHARE_WIDTH,
  type ShareCardOptions,
  type ShareOutcome,
} from './share-types';

/**
 * The `width`/`height` to hand react-native-view-shot for a SHARE_WIDTH x SHARE_HEIGHT
 * image. Android reads them as pixels. iOS reads them as points and renders at the
 * screen's scale, so 1080 x 1920 came out 3240 x 5760 (and 4-13 MB) on a 3x iPhone: there
 * they are divided by the pixel ratio (360 x 640 pt at 3x, 540 x 960 pt at 2x).
 */
export function captureSize(
  os: string = Platform.OS,
  ratio: number = PixelRatio.get(),
): { width: number; height: number } {
  const scale = os === 'ios' && ratio > 0 ? ratio : 1;
  return { width: SHARE_WIDTH / scale, height: SHARE_HEIGHT / scale };
}

/**
 * Native: capture the rendered card (`view`, the same component the story shows) to a
 * 1080 x 1920 PNG in the cache with react-native-view-shot. Rejects when the capture
 * fails (the caller can retry without covers: see `useShareCard`). The web build has its
 * own module (`share-card.web.ts`: html-to-image, then the Web Share API or a download).
 */
export function captureCard(view: View, fileName: string): Promise<CapturedCard> {
  return captureRef(view, {
    format: 'png',
    quality: 1,
    ...captureSize(),
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
