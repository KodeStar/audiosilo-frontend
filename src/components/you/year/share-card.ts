import * as Sharing from 'expo-sharing';
import type { View } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import {
  type CapturedCard,
  SHARE_HEIGHT,
  SHARE_WIDTH,
  type ShareCardOptions,
  type ShareOutcome,
} from './share-types';

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
