import { type ComponentType, useEffect, useState } from 'react';

import { afterPaint } from './after-paint';

/**
 * A component whose module loads only once the page has painted (`afterPaint`), for UI the
 * first screen never shows: overlays that open on a key or a press, listeners. Renders
 * nothing until its module is in; mounted again, it renders at once. A failed load (offline
 * with nothing cached) leaves it empty and lets the next mount try again.
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
    useEffect(() => {
      if (Component) return;
      let live = true;
      const cancel = afterPaint(() => {
        start().then(
          (component) => {
            if (live) setComponent(() => component);
          },
          (err: unknown) => console.warn('[deferred] load failed', err),
        );
      });
      return () => {
        live = false;
        cancel();
      };
    }, [Component]);
    return Component ? <Component {...props} /> : null;
  }
  return Deferred;
}
