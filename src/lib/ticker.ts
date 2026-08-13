/**
 * One `setInterval`, started and stopped by name.
 *
 * The eight lines around a nullable interval handle - start it if it is not running,
 * clear it and null the handle if it is - are written the same way everywhere a module
 * needs a repeating check it can switch off. This is that shape, once.
 *
 * `start()` is IDEMPOTENT: a start while it is already running leaves the existing
 * interval alone rather than re-basing it, so the next run happens when it was already
 * going to.
 *
 * The caller that DEPENDS on that is auto sleep's 60s poll: it is started from several
 * edges (a play edge, a timer ending, the setting being switched on), at arbitrary points
 * in the period, and re-basing would let a burst of edges defer the next check
 * indefinitely - the check is the whole feature. The sleep timer's fade ticker also calls
 * `start()` from inside its own callback, but that one is indifferent: a re-base AT the
 * tick instant schedules the next run exactly where the existing interval already had it.
 *
 * Nothing relies on a restart: every caller recomputes what it needs from the live
 * clock (or the live player state) on each run, so what matters is that it is running,
 * not where in the period it lands.
 */
export function ticker(fn: () => void, ms: number) {
  let id: ReturnType<typeof setInterval> | null = null;
  return {
    start() {
      if (id !== null) return;
      id = setInterval(fn, ms);
    },
    stop() {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    },
  };
}
