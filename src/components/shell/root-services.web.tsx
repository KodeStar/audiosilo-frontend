import { deferred } from '@/lib/deferred';

/**
 * The web's root services and listeners, from their module's loader: they and what only
 * they import (the cast session, the car and address runners, the sleep and drift
 * controllers) load after the first screen has painted, and the services start as the
 * listeners mount (`RootServices`). None of them acts before a book plays, and the web
 * engine never has one playing at launch (native can: there they start with the first
 * commit, `root-services.tsx`).
 */
export const RootListeners = deferred(() =>
  import('./root-services-impl').then((m) => m.RootServices),
);

/** Native's start of the services; the web starts them with `RootListeners`, see above. */
export function useRootServices() {}
