/** Options of {@link createBatchLoader}. */
export type BatchLoaderOptions<K, V> = {
  /** How long a batch collects keys after its first one before it loads. */
  windowMs: number;
  /** The most distinct keys one `load` call takes: a bigger batch is split. */
  maxKeys: number;
  /** Load the values of these keys (distinct, at most `maxKeys`, in the order first
   * asked for), each in the answer under its key. */
  load: (keys: K[]) => Promise<Map<K, V>>;
};

/** One caller of the loader: how to settle the promise it was handed. */
type Waiter<V> = { resolve: (value: V) => void; reject: (e: unknown) => void };

/**
 * A loader that answers many single-key requests with few batched ones: every key asked
 * for within `windowMs` of the batch's first is collected (a repeated key once), split
 * into chunks of at most `maxKeys`, and each chunk is one `load` call. Each caller
 * resolves with its key's value; a chunk whose `load` fails rejects every caller in it
 * (and no other), and a caller whose key the answer lacks rejects with an `Error`. A key
 * asked for after the window has closed opens the next batch.
 *
 * There is no cancel: a batch is shared, so no one caller can stop it.
 */
export function createBatchLoader<K, V>({
  windowMs,
  maxKeys,
  load,
}: BatchLoaderOptions<K, V>): (key: K) => Promise<V> {
  let pending: Map<K, Waiter<V>[]> | null = null;

  const send = (batch: Map<K, Waiter<V>[]>) => {
    const keys = [...batch.keys()];
    for (let i = 0; i < keys.length; i += maxKeys) {
      const chunk = keys.slice(i, i + maxKeys);
      // (A `load` that throws instead of rejecting fails its chunk the same way.)
      Promise.resolve()
        .then(() => load(chunk))
        .then(
          (values) => {
            for (const key of chunk) {
              const waiters = batch.get(key)!;
              if (values.has(key)) waiters.forEach((w) => w.resolve(values.get(key)!));
              else {
                const missing = new Error(`batch answer has no value for ${String(key)}`);
                waiters.forEach((w) => w.reject(missing));
              }
            }
          },
          (e) => chunk.forEach((key) => batch.get(key)!.forEach((w) => w.reject(e))),
        );
    }
  };

  return (key) =>
    new Promise<V>((resolve, reject) => {
      if (!pending) {
        const opened = new Map<K, Waiter<V>[]>();
        pending = opened;
        setTimeout(() => {
          pending = null;
          send(opened);
        }, windowMs);
      }
      const waiters = pending.get(key);
      if (waiters) waiters.push({ resolve, reject });
      else pending.set(key, [{ resolve, reject }]);
    });
}
