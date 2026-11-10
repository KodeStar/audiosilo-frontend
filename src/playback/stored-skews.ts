/**
 * The stored server clock skews' one reader (fe#211). They live in the listening outbox's
 * sync state (`clockSkewMs`), which the outbox reads under its lock; it registers that read
 * here as it loads, and `progress-sync`'s merges ask through `readStoredSkews`, so that
 * module never reads the outbox's document itself. A module of its own, imported by both:
 * `progress-sync` cannot import the outbox (the outbox imports it). None registered (a
 * reader loaded without the outbox): no stored skews, only this launch's measurements.
 */
type SkewReader = () => Promise<Record<string, number>>;

let reader: SkewReader | null = null;

/** The outbox's reader of the stored skews. */
export function provideStoredSkews(read: SkewReader): void {
  reader = read;
}

/** Whether a reader is registered yet. */
export function hasStoredSkews(): boolean {
  return reader !== null;
}

/** Each connection's stored skew (ms), through the registered reader; none without one. */
export function readStoredSkews(): Promise<Record<string, number>> {
  return reader ? reader() : Promise.resolve({});
}
