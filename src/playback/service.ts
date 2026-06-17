import type { PlaybackService } from './types';

// Fallback used only for type resolution. Metro substitutes service.web.ts on
// web and service.native.ts on iOS/Android.
export function createPlaybackService(): PlaybackService {
  throw new Error('No playback engine is available for this platform.');
}
