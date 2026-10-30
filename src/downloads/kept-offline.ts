/**
 * Whether a book is in this device's downloads registry, for code the downloads store
 * can't be imported into (it imports the API hooks, which ask this: `fetchBookProgress`).
 * The store registers its check as it loads; until it has, no book is kept.
 */
type KeptCheck = (connectionId: string, libraryId: number, path: string) => boolean;

let check: KeptCheck = () => false;

/** The downloads store's check (`src/downloads/store.ts`). */
export function setKeptOfflineCheck(fn: KeptCheck): void {
  check = fn;
}

/** Whether the book has a downloads entry on this device (downloaded, or on its way). */
export function isKeptOffline(connectionId: string, libraryId: number, path: string): boolean {
  return check(connectionId, libraryId, path);
}
