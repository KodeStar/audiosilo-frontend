/// <reference lib="dom" />
import { BASE_URL as BASE } from '@/lib/base-url';

import type { DownloadEngine, DownloadProgressCb } from './types';

// Web downloads live in the Cache API under synthetic, same-origin "virtual" urls
// inside the service-worker scope. The SW (public/sw.js) intercepts requests for
// these urls and serves the cached bytes — with Range support — so a downloaded
// book plays in <audio> with no network. The store is engine-agnostic: it stores
// the returned virtual url as the file's localUri exactly like a native file://.
const MEDIA_CACHE = 'audiosilo-media-v1'; // keep in sync with public/sw.js

// On the static-render/SSR pass (Node) or in an insecure context the Cache API is
// absent; the engine then reports unsupported and the UI shows downloads as such.
const supported = typeof window !== 'undefined' && typeof caches !== 'undefined';

/** djb2 hash → short hex, mirroring engine.native so the scheme is familiar. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** A url-safe, collision-resistant segment for a book's rel_path. */
function slug(path: string): string {
  const base = path
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(-40);
  return `${base || 'book'}-${hash(path)}`;
}

/** Same-origin, in-scope url prefix for a book's files (ends with `/`). */
function bookPrefix(libraryId: number, path: string): string {
  return `${location.origin}${BASE}/_offline/${libraryId}/${slug(path)}/`;
}

/** Resolve true once our service worker controls this page (it serves the cached
 * `_offline/` bytes). On a first-ever load this can race SW activation, so wait
 * briefly for it to take control before giving up. */
async function hasControllingSW(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  const sw = navigator.serviceWorker;
  if (!sw) return false;
  if (sw.controller) return true;
  await sw.ready.catch(() => undefined);
  if (!sw.controller) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      sw.addEventListener(
        'controllerchange',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
  return !!sw.controller;
}

/** A Range request for an `_offline/` url only comes back 206 from our SW's media
 * handler; the network / SPA fallback for an unknown path won't. So a 206 confirms
 * the SW — not the server — answered with the cached bytes. */
async function servedBySW(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    return res.status === 206;
  } catch {
    return false;
  }
}

let persisted = false;
/** Ask the browser to keep our cache durable (best-effort; granted silently for
 * installed PWAs and engaged sites). */
async function requestPersistence() {
  if (persisted) return;
  persisted = true;
  try {
    await navigator.storage?.persist?.();
  } catch {
    // best-effort; active PWAs are unlikely to be evicted anyway
  }
}

export const engine: DownloadEngine = {
  supported,

  async downloadFile(
    libraryId,
    path,
    fileName,
    url,
    onProgress?: DownloadProgressCb,
    signal?: AbortSignal,
  ) {
    await requestPersistence();
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const total = Number(res.headers.get('Content-Length') ?? 0);
    const contentType = res.headers.get('Content-Type') ?? 'application/octet-stream';

    // Stream the body so we can report progress (fetch has no native download
    // progress), then store the assembled blob.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress?.(received, total || received);
    }

    const blob = new Blob(chunks as BlobPart[], { type: contentType });
    const virtualUri = bookPrefix(libraryId, path) + fileName;
    const cache = await caches.open(MEDIA_CACHE);
    await cache.put(
      virtualUri,
      new Response(blob, {
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(blob.size),
          'Accept-Ranges': 'bytes',
        },
      }),
    );
    return virtualUri;
  },

  async fileExists(localUri) {
    try {
      const cache = await caches.open(MEDIA_CACHE);
      return !!(await cache.match(localUri));
    } catch {
      return false;
    }
  },

  async verify(localUri) {
    if (!supported || !(await hasControllingSW())) return false;
    return servedBySW(localUri);
  },

  async probe() {
    if (!supported || !(await hasControllingSW())) return false;
    // Self-test: stash a throwaway file under an in-scope `_offline/` url and confirm
    // the SW serves it back, then clean up. Proves end-to-end offline playback works
    // without needing a real download, so the UI can hide downloads up front.
    const url = `${location.origin}${BASE}/_offline/__probe__`;
    try {
      const cache = await caches.open(MEDIA_CACHE);
      await cache.put(
        url,
        new Response(new Blob([new Uint8Array([0])]), {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': '1',
            'Accept-Ranges': 'bytes',
          },
        }),
      );
      return await servedBySW(url);
    } catch {
      return false;
    } finally {
      try {
        await (await caches.open(MEDIA_CACHE)).delete(url);
      } catch {
        // best-effort cleanup
      }
    }
  },

  async removeBook(libraryId, path) {
    try {
      const cache = await caches.open(MEDIA_CACHE);
      const prefix = bookPrefix(libraryId, path);
      const keys = await cache.keys();
      await Promise.all(
        keys.filter((req) => req.url.startsWith(prefix)).map((req) => cache.delete(req)),
      );
    } catch {
      // best-effort cleanup
    }
  },

  async totalBytesUsed() {
    try {
      const cache = await caches.open(MEDIA_CACHE);
      const keys = await cache.keys();
      let total = 0;
      for (const req of keys) {
        const res = await cache.match(req);
        total += Number(res?.headers.get('Content-Length') ?? 0);
      }
      return total;
    } catch {
      return 0;
    }
  },
};
