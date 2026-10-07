import type { View } from 'react-native';

import { downloadBlob } from '@/lib/download-blob';

import {
  type CapturedCard,
  SHARE_HEIGHT,
  SHARE_WIDTH,
  type ShareCardOptions,
  type ShareOutcome,
} from './share-card';

export { SHARE_HEIGHT, SHARE_WIDTH };
export type { CapturedCard, ShareCardOptions, ShareOutcome };

/**
 * Web: rasterise the rendered card's DOM node (the same component the story shows) to a
 * 1080 x 1920 PNG with html2canvas, react-native-view-shot's own web engine, called
 * directly so it draws at the share size instead of upscaling a screen-sized bitmap.
 * html2canvas is loaded on first use (its own chunk, out of the main bundle).
 *
 * It works under the server's `/web` CSP: it reads the page's own stylesheets and draws
 * same-origin images (covers come from the server that serves the player), SVG through
 * `data:` images (`img-src data:`), and never fetches (`connect-src 'self'` blocks a
 * `fetch()` of a `data:` URL); the PNG comes out of `canvas.toBlob`, not a data URL.
 * A cross-origin cover (a dev server on another port) is left out rather than tainting
 * the canvas.
 *
 * `deliverCard` then uses the Web Share API when the browser can share files (phones, Safari, Chrome on
 * macOS and Windows), else a download. A share the browser refuses (Safari wants it
 * close to the tap, and the drawing takes a moment) falls back to the download too.
 */
export function captureCard(view: View, _fileName: string): Promise<CapturedCard> {
  return renderPng(view as unknown as HTMLElement);
}

/** Web: share the PNG (Web Share API) or download it; see `captureCard`. */
export async function deliverCard(
  card: CapturedCard,
  opts: ShareCardOptions,
): Promise<ShareOutcome> {
  const blob = card as Blob;
  const nav = globalThis.navigator as Navigator | undefined;
  if (typeof File !== 'undefined' && nav?.share && nav.canShare) {
    const file = new File([blob], opts.fileName, { type: 'image/png' });
    if (nav.canShare({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: opts.title });
        return 'shared';
      } catch (e) {
        // The listener closed the sheet: done, nothing to fall back to.
        if ((e as { name?: string }).name === 'AbortError') return 'shared';
        // NotAllowedError (the tap's activation ran out) and the rest: download instead.
      }
    }
  }
  downloadBlob(blob, opts.fileName);
  return 'downloaded';
}

async function renderPng(node: HTMLElement): Promise<Blob> {
  const { default: html2canvas } = await import('html2canvas');
  const box = node.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) throw new Error('The card is not on screen');
  const drawn = await html2canvas(node, {
    scale: SHARE_WIDTH / box.width,
    useCORS: true,
    backgroundColor: null,
    logging: false,
  });
  // Layout rounding can leave the drawing a pixel off 1080 x 1920: fit it exactly.
  let canvas = drawn;
  if (drawn.width !== SHARE_WIDTH || drawn.height !== SHARE_HEIGHT) {
    canvas = document.createElement('canvas');
    canvas.width = SHARE_WIDTH;
    canvas.height = SHARE_HEIGHT;
    canvas.getContext('2d')?.drawImage(drawn, 0, 0, SHARE_WIDTH, SHARE_HEIGHT);
  }
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('The card could not be drawn'))),
      'image/png',
    ),
  );
}
