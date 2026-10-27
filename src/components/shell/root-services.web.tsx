import { useEffect } from 'react';

import { afterPaint } from '@/lib/after-paint';
import { deferred } from '@/lib/deferred';

type Impl = typeof import('./root-services-impl');

/**
 * The web's root services, from their module's loader: they and what only they import (the
 * cast session, the car and address runners, the sleep and drift controllers) load after
 * the first screen has painted. None of them acts before a book plays, and the web engine
 * never has one playing at launch (native can: there they start with the first commit,
 * `root-services.tsx`). The loader is a parameter for the tests.
 */
export function rootServices(load: () => Promise<Impl>) {
  const RootListeners = deferred(() => load().then((m) => m.RootListeners));

  /** The web's `useRootServices`: starts them once the page has painted; see above. */
  function useRootServices() {
    useEffect(() => {
      let live = true;
      let stop: (() => void) | undefined;
      const cancel = afterPaint(() => {
        load().then(
          (m) => {
            if (live) stop = m.startRootServices();
          },
          (err: unknown) => console.warn('[root-services] load failed', err),
        );
      });
      return () => {
        live = false;
        cancel();
        stop?.();
      };
    }, []);
  }

  return { RootListeners, useRootServices };
}

export const { RootListeners, useRootServices } = rootServices(
  () => import('./root-services-impl'),
);
