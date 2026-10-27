import { type ComponentType, useEffect, useState } from 'react';

import { afterPaint } from './after-paint';

/** How long after a failed load a mounted `deferred` component tries again. */
export const DEFERRED_RETRY_MS = 10_000;

/**
 * A component whose module loads only once the page has painted (`afterPaint`), for UI the
 * first screen never shows: overlays that open on a key or a press, listeners. Renders
 * nothing until its module is in; mounted again, it renders at once. A failed load (offline
 * with nothing cached) leaves it empty and tries again `DEFERRED_RETRY_MS` later while it
 * stays mounted (the root's services mount once, for the app's lifetime), and on the next
 * mount.
 *
 * `load` is a dynamic `import()`: the web build (Expo's async chunks) splits the module
 * and what only it imports out of the start. For the web's own files (the web shell); a
 * shared file keeps its static imports, so native never changes.
 */
export function deferred<P extends object>(
  load: () => Promise<ComponentType<P>>,
): ComponentType<P> {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  const start = () => {
    pending ??= load().then(
      (component) => (loaded = component),
      (err: unknown) => {
        pending = undefined;
        throw err;
      },
    );
    return pending;
  };

  function Deferred(props: P) {
    const [Component, setComponent] = useState(() => loaded);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      if (Component) return;
      let live = true;
      let retry: ReturnType<typeof setTimeout> | undefined;
      const cancel = afterPaint(() => {
        start().then(
          (component) => {
            if (live) setComponent(() => component);
          },
          (err: unknown) => {
            console.warn('[deferred] load failed', err);
            if (live) retry = setTimeout(() => setAttempt((n) => n + 1), DEFERRED_RETRY_MS);
          },
        );
      });
      return () => {
        live = false;
        cancel();
        clearTimeout(retry);
      };
    }, [Component, attempt]);
    return Component ? <Component {...props} /> : null;
  }
  return Deferred;
}
