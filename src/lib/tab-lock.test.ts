import { Platform } from 'react-native';

import { fakeWebLocks } from '@/testing/fake-web-locks';

import {
  heldWebLocks,
  holdWebLock,
  LEASE_MS,
  type LeaseStorage,
  tabLock,
  whenWebLockFree,
  withLease,
} from './tab-lock';

/** A `localStorage` two tabs share (one Map). */
function sharedStorage(): LeaseStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('withLease (plain-http tabs, fe#208)', () => {
  it('two tabs never run their jobs at the same time', async () => {
    const storage = sharedStorage();
    const log: string[] = [];
    const job = (who: string) => async () => {
      log.push(`${who} in`);
      await new Promise((r) => setTimeout(r, 40));
      log.push(`${who} out`);
    };
    await Promise.all([withLease(storage, 'doc', job('a')), withLease(storage, 'doc', job('b'))]);
    expect(log).toHaveLength(4);
    // Each job's in and out are next to each other: no interleaving.
    expect(log[0].split(' ')[0]).toBe(log[1].split(' ')[0]);
    expect(log[2].split(' ')[0]).toBe(log[3].split(' ')[0]);
    expect(storage.data.size).toBe(0); // released
  });

  it('takes over a lease a closed tab left once it ran out, not before', async () => {
    const storage = sharedStorage();
    storage.setItem(
      'audiosilo-lock:doc',
      JSON.stringify({ token: 'gone', until: Date.now() + 150 }),
    );
    const started = Date.now();
    let ranAt = 0;
    await withLease(storage, 'doc', async () => {
      ranAt = Date.now();
    });
    expect(ranAt - started).toBeGreaterThanOrEqual(140);
    expect(ranAt - started).toBeLessThan(LEASE_MS);
  });

  it('runs the job when storage refuses writes, and returns its value', async () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    };
    await expect(withLease(storage, 'doc', async () => 7)).resolves.toBe(7);
  });

  it('does not release a lease another tab holds now (its own ran out meanwhile)', async () => {
    const storage = sharedStorage();
    await withLease(storage, 'doc', async () => {
      storage.setItem(
        'audiosilo-lock:doc',
        JSON.stringify({ token: 'other', until: Date.now() + 1000 }),
      );
    });
    expect(JSON.parse(storage.data.get('audiosilo-lock:doc')!).token).toBe('other');
  });
});

describe('tabLock', () => {
  const nav = globalThis.navigator as { locks?: unknown };
  afterEach(() => {
    delete nav.locks;
  });

  it('uses Web Locks where the browser has them', async () => {
    const request = jest.fn(async (_name: string, job: () => Promise<unknown>) => job());
    Object.defineProperty(nav, 'locks', { configurable: true, value: { request } });
    await expect(tabLock('doc')(async () => 'done')).resolves.toBe('done');
    expect(request).toHaveBeenCalledWith('doc', expect.any(Function));
  });

  it('runs one job at a time in this runtime without either (the app)', async () => {
    Object.defineProperty(nav, 'locks', { configurable: true, value: undefined });
    expect(Platform.OS).not.toBe('web');
    const lock = tabLock('doc');
    const log: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        lock(async () => {
          log.push(n);
          await Promise.resolve();
          log.push(-n);
        }),
      ),
    );
    expect(log).toEqual([1, -1, 2, -2, 3, -3]);
  });
});

describe('a Web Lock held for as long as its tab works', () => {
  const nav = globalThis.navigator as { locks?: unknown };
  afterEach(() => {
    delete nav.locks;
  });

  it('is seen and waited on by the other tabs until released, or until its tab goes', async () => {
    const locks = fakeWebLocks();
    Object.defineProperty(nav, 'locks', { configurable: true, value: locks });
    const release = holdWebLock('work');
    expect(await heldWebLocks()).toEqual(new Set(['work']));
    let free = false;
    const waiting = whenWebLockFree('work').then(() => (free = true));
    await Promise.resolve();
    expect(free).toBe(false);
    release();
    await waiting;
    expect(await heldWebLocks()).toEqual(new Set());
    // Its tab closed: the browser frees the lock, with no release called.
    holdWebLock('work');
    const gone = whenWebLockFree('work');
    locks.close('work');
    await gone;
    expect(await heldWebLocks()).toEqual(new Set());
  });

  it('holds nothing without Web Locks', async () => {
    Object.defineProperty(nav, 'locks', { configurable: true, value: undefined });
    holdWebLock('work')();
    expect(await heldWebLocks()).toEqual(new Set());
    await whenWebLockFree('work');
  });
});
