import type { DownloadEntry, StorageEstimate } from './types';

/**
 * The Downloads page's arithmetic, pure: which rows go where, how much each server
 * holds, and what the storage bar draws. The screen (`components/downloads/`) only
 * renders what these return.
 */

/** Bytes a download holds on the device (written so far; the total once finished). */
export function entryBytes(e: Pick<DownloadEntry, 'bytes' | 'totalBytes' | 'status'>): number {
  return e.status === 'downloaded' ? Math.max(e.bytes, e.totalBytes) : e.bytes;
}

/** Bytes still to fetch for a running download, when its total is known. */
export function bytesToGo(e: Pick<DownloadEntry, 'bytes' | 'totalBytes'>): number | null {
  return e.totalBytes > 0 ? Math.max(0, e.totalBytes - e.bytes) : null;
}

const ACTIVE_ORDER = { downloading: 0, queued: 1, error: 2 } as const;

/** The two lists: in progress (running first, then waiting in the order asked, then
 * failed) and ready offline (newest first). */
export function splitDownloads(entries: Iterable<DownloadEntry>): {
  active: DownloadEntry[];
  ready: DownloadEntry[];
} {
  const active: DownloadEntry[] = [];
  const ready: DownloadEntry[] = [];
  for (const e of entries) (e.status === 'downloaded' ? ready : active).push(e);
  active.sort(
    (a, b) =>
      ACTIVE_ORDER[a.status as keyof typeof ACTIVE_ORDER] -
        ACTIVE_ORDER[b.status as keyof typeof ACTIVE_ORDER] ||
      a.manifest.savedAt.localeCompare(b.manifest.savedAt),
  );
  ready.sort((a, b) => b.manifest.savedAt.localeCompare(a.manifest.savedAt));
  return { active, ready };
}

export type ServerRef = { id: string; name: string };

export type ServerGroup = {
  connectionId: string;
  /** The server's name; empty for a connection no longer signed in. */
  name: string;
  entries: DownloadEntry[];
  bytes: number;
};

/** Ready downloads grouped by server, in the order the servers are listed (unknown
 * connections last), keeping each group's order. */
export function groupByServer(
  entries: readonly DownloadEntry[],
  servers: readonly ServerRef[],
): ServerGroup[] {
  const groups = new Map<string, ServerGroup>();
  for (const e of entries) {
    let g = groups.get(e.connectionId);
    if (!g) {
      g = {
        connectionId: e.connectionId,
        name: servers.find((s) => s.id === e.connectionId)?.name ?? '',
        entries: [],
        bytes: 0,
      };
      groups.set(e.connectionId, g);
    }
    g.entries.push(e);
    g.bytes += entryBytes(e);
  }
  const rank = (id: string) => {
    const i = servers.findIndex((s) => s.id === id);
    return i < 0 ? servers.length : i;
  };
  return [...groups.values()].sort((a, b) => rank(a.connectionId) - rank(b.connectionId));
}

/** The storage bar has five categorical colours (`chart-1..5`); a sixth server and on
 * fold into one "other servers" segment. */
export const CHART_COLOURS = 5;

export type StorageSegment =
  | { kind: 'server'; connectionId: string; name: string; bytes: number; colour: number }
  | { kind: 'more-servers'; count: number; bytes: number }
  | { kind: 'other-apps'; bytes: number };

export type StorageBar = {
  /** What the bar's full width stands for: the device's disk, the browser's quota, or
   * (when neither is knowable) just the downloads. */
  scale: number;
  segments: StorageSegment[];
  /** Everything on this device's or browser's books, in bytes. */
  used: number;
};

/**
 * The "Storage per server" bar. Each server with books on the device is a segment in
 * `chart-1..5` order (a sixth and on fold into one); on a device, the rest of the used
 * disk is "Other apps" (knowable there: capacity - free - ours). A browser can't see
 * other apps (its quota is per site), so it never shows that segment. `used` prefers
 * the engine's measurement (`totalBytesUsed`, which also counts files the registry no
 * longer lists) over the registry's sum.
 */
export function storageBar(
  groups: readonly Pick<ServerGroup, 'connectionId' | 'name' | 'bytes'>[],
  estimate: StorageEstimate | null,
  measured: number | null,
): StorageBar {
  const listed = groups.filter((g) => g.bytes > 0);
  const sum = listed.reduce((s, g) => s + g.bytes, 0);
  const used = Math.max(sum, measured ?? 0);
  const segments: StorageSegment[] = listed.slice(0, CHART_COLOURS).map((g, i) => ({
    kind: 'server',
    connectionId: g.connectionId,
    name: g.name,
    bytes: g.bytes,
    colour: i + 1,
  }));
  const rest = listed.slice(CHART_COLOURS);
  if (rest.length > 0)
    segments.push({
      kind: 'more-servers',
      count: rest.length,
      bytes: rest.reduce((s, g) => s + g.bytes, 0),
    });
  if (estimate?.scope === 'device') {
    const other = estimate.capacity - estimate.free - used;
    if (other > 0) segments.push({ kind: 'other-apps', bytes: other });
  }
  const scale = estimate ? Math.max(estimate.capacity, used) : used;
  return { scale, segments, used };
}

/** Why downloads can't work in this browser, most fundamental first:
 * `insecure` (Cache API and service workers need https or localhost), `no-cache` (no
 * Cache API at all), `no-worker` (the offline service worker isn't serving). */
export type UnsupportedReason = 'insecure' | 'no-cache' | 'no-worker';

export function unsupportedReason(env: { secure: boolean; caches: boolean }): UnsupportedReason {
  if (!env.secure) return 'insecure';
  if (!env.caches) return 'no-cache';
  return 'no-worker';
}
