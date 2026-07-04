import { Directory, File, Paths } from 'expo-file-system';

import type { DownloadEngine, DownloadProgressCb } from './types';

const ROOT = 'downloads';

/** djb2 hash → short hex, to disambiguate slugified paths that collide. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** A filesystem-safe, collision-resistant directory name for a book's rel_path. */
function slug(path: string): string {
  const base = path
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(-40);
  return `${base || 'book'}-${hash(path)}`;
}

function rootDir(): Directory {
  return new Directory(Paths.document, ROOT);
}

function bookDir(connectionId: string, libraryId: number, path: string): Directory {
  return new Directory(Paths.document, ROOT, connectionId, String(libraryId), slug(path));
}

function ensureDir(dir: Directory) {
  if (!dir.exists) dir.create({ intermediates: true });
}

function dirSize(dir: Directory): number {
  let total = 0;
  for (const item of dir.list()) {
    if (item instanceof File) total += item.size ?? 0;
    else total += dirSize(item);
  }
  return total;
}

/** Native downloads via expo-file-system, stored under the (persistent) document
 * directory so they survive relaunches and aren't evicted like the cache dir. */
export const engine: DownloadEngine = {
  supported: true,

  async downloadFile(
    connectionId,
    libraryId,
    path,
    fileName,
    url,
    onProgress?: DownloadProgressCb,
    signal?: AbortSignal,
  ) {
    const dir = bookDir(connectionId, libraryId, path);
    ensureDir(dir);
    const dest = new File(dir, fileName);
    if (dest.exists) dest.delete();
    const task = File.createDownloadTask(url, dest, {
      onProgress: onProgress ? (p) => onProgress(p.bytesWritten, p.totalBytes) : undefined,
      signal,
    });
    const file = await task.downloadAsync();
    if (!file) throw new Error('Download did not complete.');
    return file.uri;
  },

  async fileExists(localUri) {
    try {
      return new File(localUri).exists;
    } catch {
      return false;
    }
  },

  // Recompute the absolute uri from the live document root + deterministic
  // (connectionId, libraryId, path) layout, so a stored uri whose container path has
  // since changed still resolves to the file on disk.
  localUri(connectionId, libraryId, path, fileName) {
    return new File(bookDir(connectionId, libraryId, path), fileName).uri;
  },

  async removeBook(connectionId, libraryId, path) {
    try {
      const dir = bookDir(connectionId, libraryId, path);
      if (dir.exists) dir.delete();
    } catch {
      // best-effort cleanup
    }
  },

  async clearAll() {
    try {
      const root = rootDir();
      if (root.exists) root.delete();
    } catch {
      // best-effort: orphaned files are non-fatal, just wasted space
    }
  },

  async totalBytesUsed() {
    try {
      const root = rootDir();
      return root.exists ? dirSize(root) : 0;
    } catch {
      return 0;
    }
  },
};
