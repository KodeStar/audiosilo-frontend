import type { DownloadFailure } from './types';

// Engines report failures as whatever the platform throws: a fetch TypeError on web
// ("Failed to fetch", Safari's "Load failed"), expo-file-system's native messages, a
// QuotaExceededError from the Cache API, or the web engine's own `Download failed (404)`.
// These patterns turn them into the few cases the Downloads page can explain.
const NETWORK =
  /failed to fetch|load failed|networkerror|network request failed|network connection was lost|internet connection appears to be offline|could not connect|timed? ?out|econn|socket|unable to resolve host|connection (reset|refused|abort)/i;
const STORAGE =
  /quota|no space|enospc|disk (is )?full|not enough (free )?space|insufficient storage/i;
const STATUS = /\((\d{3})\)|status(?: code)?[:= ]+(\d{3})/i;

/** What kind of failure a thrown download error is (see {@link DownloadFailure}). */
export function classifyDownloadError(error: unknown): DownloadFailure {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (name === 'QuotaExceededError' || STORAGE.test(message)) return { kind: 'storage' };
  const status = STATUS.exec(message);
  const code = status ? Number(status[1] ?? status[2]) : NaN;
  if (code >= 400 && code < 600) return { kind: 'server', status: code };
  if (NETWORK.test(message)) return { kind: 'network' };
  return { kind: 'unknown' };
}
