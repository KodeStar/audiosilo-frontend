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
