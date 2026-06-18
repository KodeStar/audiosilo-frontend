import type { DownloadEngine } from './types';

/**
 * Web has no persistent file storage we can stream `<audio>` from without a
 * service worker — real offline caching lands in M4 (Workbox). Until then the
 * engine reports `supported: false` and the UI shows downloads as app-only.
 */
export const engine: DownloadEngine = {
  supported: false,
  downloadFile: async () => {
    throw new Error('Downloads are not supported on web yet.');
  },
  fileExists: () => false,
  removeBook: async () => {},
  totalBytesUsed: () => 0,
};
