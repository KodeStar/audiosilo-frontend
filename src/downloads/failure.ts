import type { TFunction } from 'i18next';

import type { DownloadEntry, DownloadFailure, StorageEstimate } from './types';

// Engines report failures as whatever the platform throws: a fetch TypeError on web
// ("Failed to fetch", Safari's "Load failed"), expo-file-system's native messages, a
// QuotaExceededError from the Cache API, or the web engine's own `Download failed (404)`.
// These patterns turn them into the few cases the Downloads page can explain.
const NETWORK =
  /failed to fetch|load failed|networkerror|network request failed|network connection was lost|internet connection appears to be offline|could not connect|timed? ?out|econn|socket|unable to resolve host|connection (reset|refused|abort)/i;
const STORAGE =
  /quota|no space|enospc|disk (is )?full|not enough (free )?space|insufficient storage/i;
// expo-file-system's download task says `server returned HTTP 404` (iOS) or `HTTP 404`.
const STATUS = /\((\d{3})\)|status(?: code)?[:= ]+(\d{3})|\bHTTP (\d{3})\b/i;

/** What kind of failure a thrown download error is (see {@link DownloadFailure}). */
export function classifyDownloadError(error: unknown): DownloadFailure {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (name === 'QuotaExceededError' || STORAGE.test(message)) return { kind: 'storage' };
  const status = STATUS.exec(message);
  const code = status ? Number(status[1] ?? status[2] ?? status[3]) : NaN;
  if (code >= 400 && code < 600) return { kind: 'server', status: code };
  if (NETWORK.test(message)) return { kind: 'network' };
  return { kind: 'unknown' };
}

/** What went wrong with a failed download, and whether anything was lost (STYLEGUIDE
 * section 12), as the Downloads page and the book page say it: the cause from
 * `entry.failure`, then the share kept on the device or that a retry starts over. Entries
 * saved before failures were classified read as "stopped". */
export function failureText(
  t: TFunction,
  entry: Pick<DownloadEntry, 'failure'>,
  server: string,
  scope: StorageEstimate['scope'],
): string {
  const f: DownloadFailure = entry.failure ?? { kind: 'unknown' };
  const cause = {
    network: () => t('downloads.failure.network', { server }),
    server: () => t('downloads.failure.server', { server, status: f.status }),
    storage: () =>
      t(
        scope === 'browser'
          ? 'downloads.failure.storageBrowser'
          : 'downloads.failure.storageDevice',
      ),
    unservable: () => t('downloads.failure.unservable'),
    removed: () => t('downloads.failure.removed'),
    interrupted: () => t('downloads.failure.interrupted'),
    unknown: () => t('downloads.failure.unknown'),
  }[f.kind]();
  // An unservable download is fully saved: the cause already says what to do.
  if (f.kind === 'unservable' || f.kind === 'removed') return cause;
  const kept = f.kept ?? 0;
  const tail =
    kept > 0
      ? t('downloads.failure.kept', { percent: Math.floor(Math.min(1, kept) * 100) })
      : t('downloads.failure.restart');
  return `${cause} ${tail}`;
}
