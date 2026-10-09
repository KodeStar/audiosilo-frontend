import { createBatchLoader } from './batch-loader';

/** A loader whose `load` doubles each key, recording every call's keys. */
function doubler(opts: {
  windowMs?: number;
  maxKeys?: number;
  maxSize?: number;
  fail?: (keys: number[]) => boolean;
}) {
  const calls: number[][] = [];
  const load = createBatchLoader<number, number>({
    windowMs: opts.windowMs ?? 10,
    maxKeys: opts.maxKeys ?? 50,
    size: (k) => k,
    maxSize: opts.maxSize,
    load: async (keys) => {
      calls.push(keys);
      if (opts.fail?.(keys)) throw new Error(`boom ${keys.join(',')}`);
      return new Map(keys.map((k) => [k, k * 2]));
    },
  });
  return { load, calls };
}

describe('createBatchLoader', () => {
  it('answers every key asked for within the window with one load', async () => {
    const { load, calls } = doubler({});
    const out = await Promise.all([load(1), load(2), load(3)]);
    expect(out).toEqual([2, 4, 6]);
    expect(calls).toEqual([[1, 2, 3]]);
  });

  it('collects for windowMs after the first key, not from the last one', async () => {
    jest.useFakeTimers();
    try {
      const { load, calls } = doubler({ windowMs: 10 });
      const a = load(1);
      jest.advanceTimersByTime(9);
      const b = load(2);
      jest.advanceTimersByTime(1);
      const c = load(3);
      jest.advanceTimersByTime(10);
      await expect(Promise.all([a, b, c])).resolves.toEqual([2, 4, 6]);
      expect(calls).toEqual([[1, 2], [3]]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('loads a repeated key once and answers each of its callers', async () => {
    const { load, calls } = doubler({});
    const out = await Promise.all([load(7), load(8), load(7)]);
    expect(out).toEqual([14, 16, 14]);
    expect(calls).toEqual([[7, 8]]);
  });

  it('hands every caller of one key in a batch the same promise', () => {
    const { load } = doubler({});
    const a = load(7);
    expect(load(7)).toBe(a);
    expect(load(8)).not.toBe(a);
    return a;
  });

  it('splits a batch into loads of at most maxKeys, in the order asked', async () => {
    const { load, calls } = doubler({ maxKeys: 2 });
    const out = await Promise.all([1, 2, 3, 4, 5].map(load));
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(calls).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('also splits a batch so no load exceeds maxSize, an oversized key alone', async () => {
    const { load, calls } = doubler({ maxSize: 10 });
    const out = await Promise.all([4, 5, 2, 12, 3].map((k) => load(k)));
    expect(out).toEqual([8, 10, 4, 24, 6]);
    expect(calls).toEqual([[4, 5], [2], [12], [3]]);
  });

  it('rejects every caller of a failed chunk, and only those', async () => {
    const { load } = doubler({ maxKeys: 2, fail: (keys) => keys.includes(3) });
    const results = await Promise.allSettled([1, 2, 3, 4, 5, 3].map(load));
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'rejected',
      'rejected',
      'fulfilled',
      'rejected',
    ]);
    expect((results[2] as PromiseRejectedResult).reason).toEqual(new Error('boom 3,4'));
  });

  it('fails the chunk the same way when load throws instead of rejecting', async () => {
    const load = createBatchLoader<number, number>({
      windowMs: 1,
      maxKeys: 10,
      load: () => {
        throw new Error('sync');
      },
    });
    await expect(load(1)).rejects.toThrow('sync');
  });

  it('rejects its callers, not leaves them waiting, when the answer cannot be read', async () => {
    const load = createBatchLoader<number, number>({
      windowMs: 1,
      maxKeys: 10,
      // Not a Map: reading it throws after load has resolved.
      load: async () => undefined as unknown as Map<number, number>,
    });
    const results = await Promise.allSettled([load(1), load(2)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });

  it('refuses a maxKeys that could never split a batch', () => {
    for (const maxKeys of [0, -1, Number.NaN]) {
      expect(() =>
        createBatchLoader({ windowMs: 1, maxKeys, load: async () => new Map() }),
      ).toThrow(RangeError);
    }
  });

  it('rejects only the caller whose key the answer lacks', async () => {
    const load = createBatchLoader<string, string>({
      windowMs: 1,
      maxKeys: 10,
      load: async () => new Map([['a', 'A']]),
    });
    const [a, b] = await Promise.allSettled([load('a'), load('b')]);
    expect(a).toEqual({ status: 'fulfilled', value: 'A' });
    expect((b as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect((b as PromiseRejectedResult).reason.message).toContain('b');
  });

  it('opens a new batch for a key asked for after the window closed', async () => {
    const { load, calls } = doubler({});
    await load(1);
    await Promise.all([load(1), load(2)]);
    expect(calls).toEqual([[1], [1, 2]]);
  });
});
