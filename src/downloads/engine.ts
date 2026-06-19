import type { DownloadEngine } from './types';

// Fallback used only for type resolution. Metro substitutes engine.web.ts on web
// and engine.native.ts on iOS/Android.
export const engine: DownloadEngine = {
  supported: false,
  downloadFile: async () => {
    throw new Error('No download engine is available for this platform.');
  },
  fileExists: async () => false,
  removeBook: async () => {},
  totalBytesUsed: async () => 0,
};
