import { useEffect } from 'react';

import { startRootServices } from './root-services-impl';

export { RootListeners } from './root-services-impl';

/**
 * The app's lifetime services (`startRootServices`), started when the root layout mounts
 * and stopped when it goes. Native starts them with the first commit; the web's
 * `root-services.web.tsx` once the first screen has painted.
 */
export function useRootServices() {
  useEffect(() => startRootServices(), []);
}
