import { Platform } from 'react-native';

import { hasWebLocks, heldWebLocks, holdWebLock, whenWebLockFree } from '@/lib/tab-lock';

/**
 * Web: which tab of the browser is running each download. The tabs share one stored
 * registry but each runs its own downloads, and a download on its way lives only in its
 * tab: reloaded (or opened) meanwhile, another tab read the entry as cut short, marked it
 * Interrupted and emptied its folder under the transfer.
 *
 * So the tab running a download holds a Web Lock named for it, from queued to its end
 * (downloaded, failed, cancelled), released once that end is saved; the browser frees it
 * when the tab closes or crashes. A tab that finds a download's lock held by another shows
 * it as that tab's (the store's `elsewhere`), never revives it, and asks that tab to stop
 * it. Only with Web Locks (a secure context): without them the tabs cannot tell, and a
 * download on its way reads as cut short, as it always did.
 */
const PREFIX = 'audiosilo-download:';

/** The downloads this tab holds the lock of (their release), and those it is letting go
 * once their end is saved. */
const held = new Map<string, () => void>();
const leaving = new Set<string>();

/** Whether the tabs of this browser can tell whose a download is (the web, with Web Locks). */
export const tabsShareDownloads = (): boolean => Platform.OS === 'web' && hasWebLocks();

/** This tab runs the download `key` (a download key): hold its lock. */
export function holdDownload(key: string): void {
  leaving.delete(key);
  if (!held.has(key)) held.set(key, holdWebLock(PREFIX + key));
}

/** The downloads this tab holds and is not letting go. */
export function heldDownloads(): string[] {
  return [...held.keys()].filter((key) => !leaving.has(key));
}

/** This tab's download `key` ended: its lock is released once `saved` resolves (the save of
 * that end), so a tab waiting on it reads the end, not the download still on its way. A
 * save that failed (`saved` rejects) keeps it held, for a later call. Taken up again
 * meanwhile (a retry), it stays held too. */
export function releaseDownloadAfter(key: string, saved: Promise<unknown>): void {
  if (!held.has(key) || leaving.has(key)) return;
  leaving.add(key);
  void saved.then(
    () => {
      if (!leaving.delete(key)) return;
      held.get(key)?.();
      held.delete(key);
    },
    () => void leaving.delete(key),
  );
}

/** The downloads another tab is running now (their keys). None where the tabs cannot tell. */
export async function downloadsRunningElsewhere(): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!tabsShareDownloads()) return keys;
  for (const name of await heldWebLocks()) {
    if (!name.startsWith(PREFIX)) continue;
    const key = name.slice(PREFIX.length);
    if (!held.has(key)) keys.add(key);
  }
  return keys;
}

/** Resolves once the tab running the download `key` let it go: it ended there, or the tab
 * closed. */
export const whenDownloadLeft = (key: string): Promise<void> => whenWebLockFree(PREFIX + key);
