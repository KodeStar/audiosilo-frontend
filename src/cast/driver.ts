import type { CastDriver } from './types';

// Fallback used only for type resolution. Metro substitutes driver.native.ts on iOS/Android
// and driver.web.ts on the web; anything else has no Cast sender.
export const castDriver: CastDriver = {
  supported: async () => false,
  init: async () => false,
  subscribe: () => () => {},
  current: async () => null,
  endSession: async () => {},
};
