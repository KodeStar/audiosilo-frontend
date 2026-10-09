/** Options of {@link createBatchLoader}. */
export type BatchLoaderOptions<K, V> = {
  /** How long a batch collects keys after its first one before it loads. */
  windowMs: number;
  /** The most distinct keys one `load` call takes (at least 1): a bigger batch is split. */
  maxKeys: number;
  /** Optionally bounds a chunk's total size too (each key's `size`, e.g. its bytes in a
   * URL): a chunk takes keys while their sizes sum to at most `maxSize`, and a key bigger
   * than that alone goes in a chunk of its own. */
  size?: (key: K) => number;
  maxSize?: number;
  /** Load the values of these keys (distinct, at most `maxKeys`, in the order first
   * asked for), each in the answer under its key. */
  load: (keys: K[]) => Promise<Map<K, V>>;
};

/** A key's one promise in a batch, shared by every caller of that key, and how to
 * settle it. */
type Deferred<V> = {
  promise: Promise<V>;
  resolve: (value: V) => void;
  reject: (e: unknown) => void;
};

function deferred<V>(): Deferred<V> {
  let resolve!: (value: V) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<V>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A loader that answers many single-key requests with few batched ones: every key asked
 * for within `windowMs` of the batch's first is collected (a repeated key once, its
 * callers handed the same promise), split into chunks of at most `maxKeys` (and `maxSize`), and each
 * chunk is one `load` call. Each caller resolves with its key's value; a chunk whose
 * `load` fails rejects every caller in it (and no other), and a caller whose key the
 * answer lacks rejects with an `Error`. A key asked for after the window has closed
 * opens the next batch.
 *
 * There is no cancel: a batch is shared, so no one caller can stop it.
 */
export function createBatchLoader<K, V>({
  windowMs,
  maxKeys,
  size,
  maxSize = Infinity,
  load,
}: BatchLoaderOptions<K, V>): (key: K) => Promise<V> {
  // (Fewer than one key per load would never finish splitting a batch.)
  if (!(maxKeys >= 1)) throw new RangeError(`maxKeys must be at least 1, not ${maxKeys}`);
  let pending: Map<K, Deferred<V>> | null = null;

  // The batch's keys in order, cut into chunks of at most maxKeys keys and maxSize.
  const chunks = (keys: K[]): K[][] => {
    const out: K[][] = [];
    let chunk: K[] = [];
    let total = 0;
    for (const key of keys) {
      const n = size?.(key) ?? 0;
      if (chunk.length > 0 && (chunk.length >= maxKeys || total + n > maxSize)) {
        out.push(chunk);
        chunk = [];
        total = 0;
      }
      chunk.push(key);
      total += n;
    }
    if (chunk.length > 0) out.push(chunk);
    return out;
  };

  const send = (batch: Map<K, Deferred<V>>) => {
    for (const chunk of chunks([...batch.keys()])) {
      // A `load` that throws instead of rejecting, or an answer that can't be read,
      // fails its chunk the same way (a caller already answered stays answered), so no
      // caller is left waiting forever.
      Promise.resolve()
        .then(() => load(chunk))
        .then((values) => {
          for (const key of chunk) {
            const d = batch.get(key)!;
            if (values.has(key)) d.resolve(values.get(key)!);
            else d.reject(new Error(`batch answer has no value for ${String(key)}`));
          }
        })
        .catch((e: unknown) => chunk.forEach((key) => batch.get(key)!.reject(e)));
    }
  };

  return (key) => {
    if (!pending) {
      const opened = new Map<K, Deferred<V>>();
      pending = opened;
      setTimeout(() => {
        pending = null;
        send(opened);
      }, windowMs);
    }
    let d = pending.get(key);
    if (!d) {
      d = deferred<V>();
      pending.set(key, d);
    }
    return d.promise;
  };
}
