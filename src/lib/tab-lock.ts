import { Platform } from 'react-native';

import { randomUUID } from './random';
import { serialQueue } from './serial-queue';

/**
 * A lock for a read-modify-write of one stored document that every tab of the web player
 * shares (the tabs share `localStorage`), so two tabs never write over each other's change.
 * In this tab the jobs run one at a time (a serial queue); across tabs:
 * - the browser's Web Locks where it has them (secure contexts: HTTPS, localhost);
 * - else, on the web, a lease kept in `localStorage` (`withLease`): a plain-http server
 *   (TLS off, the home HTTP address) has no `navigator.locks` (fe#208);
 * - else nothing more: the app is one runtime, the serial queue is all there is.
 */
export function tabLock(name: string): <T>(job: () => Promise<T>) => Promise<T> {
  const queue = serialQueue();
  return <T>(job: () => Promise<T>): Promise<T> =>
    queue(() => {
      const locks = webLocks();
      if (locks) return locks.request(name, job);
      const storage = leaseStorage();
      return storage ? withLease(storage, name, job) : job();
    });
}

type LockManager = { request<T>(name: string, job: () => Promise<T>): Promise<T> };

/** Whether this runtime has the browser's Web Locks (a secure-context browser). */
export const hasWebLocks = (): boolean => webLocks() !== null;

/** The browser's Web Locks, or null where there are none (native, plain http). */
function webLocks(): LockManager | null {
  const locks = (globalThis.navigator as { locks?: Partial<LockManager> } | undefined)?.locks;
  return typeof locks?.request === 'function' ? (locks as LockManager) : null;
}

export type LeaseStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The web's `localStorage`, or null (native, or a browser that refuses it). */
function leaseStorage(): LeaseStorage | null {
  if (Platform.OS !== 'web') return null;
  try {
    const storage = (globalThis as { localStorage?: LeaseStorage }).localStorage;
    return storage && typeof storage.getItem === 'function' ? storage : null;
  } catch {
    return null;
  }
}

/** How long a lease stands before another tab may take it: a tab that closed or crashed
 * holding one keeps the others out at most this long. Every job under it is a few storage
 * reads and writes. */
export const LEASE_MS = 5_000;
/** How long a tab waits after writing its lease before reading it back: another tab that
 * wrote at the same moment has written by then, and only the last write holds. */
const LEASE_SETTLE_MS = 30;
/** How long a tab waits before trying again while another holds the lease (plus up to as
 * much again at random, so two tabs do not keep colliding). */
const LEASE_RETRY_MS = 25;
/** After this long without the lease (a storage that keeps failing), the job runs anyway:
 * a write that might race beats one that never happens. */
const LEASE_GIVE_UP_MS = 3 * LEASE_MS;

type Lease = { token: string; until: number };

const leaseKey = (name: string) => `audiosilo-lock:${name}`;

function readLease(storage: LeaseStorage, key: string): Lease | null {
  try {
    const raw = storage.getItem(key);
    const lease = raw ? (JSON.parse(raw) as Partial<Lease>) : null;
    return lease && typeof lease.token === 'string' && typeof lease.until === 'number'
      ? (lease as Lease)
      : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `job` holding the lease `name` in `storage`: take it when no one holds it (or the
 * holder's ran out), wait `LEASE_SETTLE_MS`, and hold it only when the lease read back is
 * still this one (two tabs writing at once: the last write wins, the other tries again).
 * Released when the job ends, unless another tab took it since (it ran out meanwhile).
 */
export async function withLease<T>(
  storage: LeaseStorage,
  name: string,
  job: () => Promise<T>,
): Promise<T> {
  const key = leaseKey(name);
  const token = randomUUID();
  const giveUpAt = Date.now() + LEASE_GIVE_UP_MS;
  for (;;) {
    const held = readLease(storage, key);
    if (!held || held.until <= Date.now()) {
      try {
        storage.setItem(key, JSON.stringify({ token, until: Date.now() + LEASE_MS }));
      } catch {
        break; // storage refuses writes: there is no lease to share
      }
      await sleep(LEASE_SETTLE_MS);
      if (readLease(storage, key)?.token === token) break;
    }
    if (Date.now() >= giveUpAt) break;
    await sleep(LEASE_RETRY_MS + Math.random() * LEASE_RETRY_MS);
  }
  try {
    return await job();
  } finally {
    try {
      if (readLease(storage, key)?.token === token) storage.removeItem(key);
    } catch {
      // A lease left behind runs out by itself.
    }
  }
}
