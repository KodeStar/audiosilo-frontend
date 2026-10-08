const mockToCanvas = jest.fn();
jest.mock('./load-rasteriser', () => ({
  loadRasteriser: async () => ({ toCanvas: (...a: unknown[]) => mockToCanvas(...a) }),
}));
const mockDownload = jest.fn();
jest.mock('@/lib/download-blob', () => ({
  downloadBlob: (...a: unknown[]) => mockDownload(...a),
}));

/* eslint-disable import/first */
import type { View } from 'react-native';

import { captureCard, deliverCard } from './share-card.web';
/* eslint-enable import/first */

const png = new Blob(['png'], { type: 'image/png' });
const opts = { fileName: 'audiosilo-2026-01-hours.png', title: 'My 2026 in listening' };
const g = globalThis as unknown as Record<string, unknown>;
const saved = { navigator: g.navigator, document: g.document, File: g.File };

/** A canvas html-to-image would hand back. */
function canvas(width: number, height: number) {
  return {
    width,
    height,
    toBlob: (cb: (b: Blob | null) => void) => cb(png),
    getContext: () => ({ drawImage: jest.fn() }),
  };
}

afterEach(() => {
  g.navigator = saved.navigator;
  g.document = saved.document;
  g.File = saved.File;
  jest.clearAllMocks();
});

describe('share a card (web)', () => {
  it('draws the card node at the share size, out of a canvas blob', async () => {
    mockToCanvas.mockResolvedValue(canvas(1080, 1920));
    const node = { getBoundingClientRect: () => ({ width: 360, height: 640 }) };
    expect(await captureCard(node as unknown as View, opts.fileName)).toBe(png);
    expect(mockToCanvas).toHaveBeenCalledWith(node, {
      pixelRatio: 3,
      skipAutoScale: true,
      includeQueryParams: true,
      cacheBust: false,
    });
  });

  it('fits a drawing that came out a pixel off to exactly 1080 x 1920', async () => {
    mockToCanvas.mockResolvedValue(canvas(1079, 1918));
    const exact = canvas(0, 0);
    g.document = { createElement: () => exact };
    const node = { getBoundingClientRect: () => ({ width: 359.7, height: 639.4 }) };
    await captureCard(node as unknown as View, opts.fileName);
    expect([exact.width, exact.height]).toEqual([1080, 1920]);
  });

  it('refuses a card that is not on screen', async () => {
    const node = { getBoundingClientRect: () => ({ width: 0, height: 0 }) };
    await expect(captureCard(node as unknown as View, opts.fileName)).rejects.toThrow();
  });

  it('shares the PNG through the Web Share API where files can be shared', async () => {
    const share = jest.fn(async () => undefined);
    g.navigator = { share, canShare: () => true };
    expect(await deliverCard(png, opts)).toBe('shared');
    const arg = (share.mock.calls[0] as unknown as [{ files: File[]; title: string }])[0];
    expect(arg.title).toBe(opts.title);
    expect(arg.files[0].name).toBe(opts.fileName);
    expect(arg.files[0].type).toBe('image/png');
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('takes a closed share sheet as done', async () => {
    g.navigator = {
      share: async () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })),
      canShare: () => true,
    };
    expect(await deliverCard(png, opts)).toBe('shared');
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('downloads when the browser refuses the share or cannot share files', async () => {
    g.navigator = {
      share: async () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })),
      canShare: () => true,
    };
    expect(await deliverCard(png, opts)).toBe('downloaded');
    expect(mockDownload).toHaveBeenCalledWith(png, opts.fileName);
    g.navigator = { share: jest.fn(), canShare: () => false };
    expect(await deliverCard(png, opts)).toBe('downloaded');
    g.navigator = {};
    expect(await deliverCard(png, opts)).toBe('downloaded');
    expect(mockDownload).toHaveBeenCalledTimes(3);
  });
});
