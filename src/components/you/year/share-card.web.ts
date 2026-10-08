import type { View } from 'react-native';

import { downloadBlob } from '@/lib/download-blob';

import { loadRasteriser } from './load-rasteriser';
import {
  type CapturedCard,
  SHARE_HEIGHT,
  SHARE_WIDTH,
  type ShareCardOptions,
  type ShareOutcome,
} from './share-types';

/**
 * Web: rasterise the rendered card's DOM node (the same component the story shows) to a
 * 1080 x 1920 PNG with html-to-image, which lets the browser itself lay the card out
 * (an SVG `foreignObject` drawn onto a canvas), so the type sits exactly where it does on
 * screen. react-native-view-shot's own web engine (html2canvas) was tried first: it
 * re-lays text out itself and clipped every line react-native-web clamps
 * (`numberOfLines`), and it upscales a screen-sized bitmap. Loaded on first use (its own
 * chunk, out of the main bundle).
 *
 * It works under the server's `/web` CSP (`connect-src 'self'`, `img-src 'self' data:
 * blob:`): the fonts and covers it inlines are same-origin `fetch()`es (covers are
 * plain URLs on the web, `BookCover`, never `blob:` ones, which `connect-src 'self'`
 * would refuse), it never fetches a `data:` URL (it keeps those as
 * they are), the drawing is a `data:` SVG image, and the PNG comes out of
 * `canvas.toBlob`. A cover it can't fetch is left blank rather than failing the card.
 *
 * `deliverCard` then uses the Web Share API when the browser can share files (phones,
 * Safari, Chrome on macOS and Windows), else a download. A share the browser refuses
 * (Safari wants it close to the tap, and the drawing takes a moment) falls back to the
 * download too.
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
  const { toCanvas } = await loadRasteriser();
  const box = node.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) throw new Error('The card is not on screen');
  const drawn = await toCanvas(node, {
    pixelRatio: SHARE_WIDTH / box.width,
    skipAutoScale: true,
    // Covers differ only in their query (`?path=`): without it they'd share one cache entry.
    includeQueryParams: true,
    cacheBust: false,
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
