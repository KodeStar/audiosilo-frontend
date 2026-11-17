/**
 * A controller started from more than one place runs once: the root layout starts the app's
 * lifetime services, and the car's stack (`src/car/car-task.ts`) starts the ones a car-only
 * session needs too, where no root layout runs (Android's headless task, a CarPlay-first
 * launch). `sharedStart(run)` returns a start whose every call returns its own release; `run`
 * is called by the first start, and its teardown by the last release (a second release of one
 * holder is a no-op). Two runs at once would race for the same module state, and either's
 * teardown would clear it under the other. A start's arguments go to `run`, so the first
 * start's win.
 */
export function sharedStart<A extends unknown[]>(
  run: (...args: A) => () => void,
): (...args: A) => () => void {
  let holders = 0;
  let teardown: (() => void) | null = null;
  return (...args) => {
    teardown ??= run(...args);
    holders++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holders--;
      if (holders > 0 || !teardown) return;
      const stop = teardown;
      teardown = null;
      stop();
    };
  };
}
