/**
 * One browser's Web Locks for tests of what the web player's tabs hold between them
 * (`navigator.locks`): one holder per name at a time, the rest granted in the order they
 * asked, and `query` naming the locks held now. `close(name)` is the tab holding `name`
 * going away: the browser frees its lock, and its job is never heard of again.
 */
export function fakeWebLocks() {
  const held = new Map<string, { close: () => void }>();
  const waiting = new Map<string, (() => void)[]>();
  const next = (name: string) => waiting.get(name)?.shift()?.();

  function request<T>(name: string, job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        let closed = false;
        const free = () => {
          if (held.get(name) !== holder) return;
          held.delete(name);
          next(name);
        };
        const holder = {
          close: () => {
            closed = true;
            free();
          },
        };
        held.set(name, holder);
        Promise.resolve()
          .then(job)
          .then(
            (value) => {
              if (closed) return;
              free();
              resolve(value);
            },
            (e: unknown) => {
              if (closed) return;
              free();
              reject(e);
            },
          );
      };
      if (held.has(name)) waiting.set(name, [...(waiting.get(name) ?? []), run]);
      else run();
    });
  }

  return {
    request,
    query: async () => ({ held: [...held.keys()].map((name) => ({ name })) }),
    /** The names held now. */
    names: () => [...held.keys()],
    close: (name: string) => held.get(name)?.close(),
  };
}
