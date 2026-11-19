/**
 * A queue that runs the jobs handed to it one at a time, in the order handed: for a
 * read-modify-write of one stored document, so two started together can never drop each
 * other's change. A job that fails rejects its own caller only; the next still runs.
 */
export function serialQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * A `serialQueue` per key: jobs of one key one at a time, in the order handed, and jobs of
 * different keys never wait for each other (a request that hangs holds its own key only). A
 * key's queue is let go once its last job settles, so the map holds only keys with work.
 */
export function keyedSerialQueue(): <T>(key: string, job: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, job: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(job, job);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}
