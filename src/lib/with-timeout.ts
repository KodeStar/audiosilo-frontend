/** `promise`'s outcome, else a rejection once `ms` pass first: an `Error` of `message`, or
 * `message` itself when it is an error (for a caller that tells it apart by identity). The
 * timer is cleared either way. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string | Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(typeof message === 'string' ? new Error(message) : message),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
