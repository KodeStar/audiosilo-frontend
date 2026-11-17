/**
 * Facts of this device's downloads registry, for code the downloads store can't be
 * imported into (it imports the API hooks, which ask `isKeptOffline` and, after a Bridge
 * job, `refreshKeptMeta`: `fetchBookProgress`,
 * the progress mirror, which asks `downloadEndsBefore`: `mirrorSpanEnd`, and the listening
 * outbox, which asks `downloadBookLength`: `resendMismatched`). The store
 * registers its checks as it loads; until it has, no book is kept and none ends early.
 */
type KeptCheck = (connectionId: string, libraryId: number, path: string) => boolean;
type EndCheck = (
  connectionId: string,
  libraryId: number,
  path: string,
) => Promise<string | undefined>;

let check: KeptCheck = () => false;
let endCheck: EndCheck = async () => undefined;

/** The downloads store's check (`src/downloads/store.ts`). */
export function setKeptOfflineCheck(fn: KeptCheck): void {
  check = fn;
}

/** Whether the book has a downloads entry on this device (downloaded, or on its way). */
export function isKeptOffline(connectionId: string, libraryId: number, path: string): boolean {
  return check(connectionId, libraryId, path);
}

/** The downloads store's end check (`src/downloads/store.ts`). */
export function setDownloadEndCheck(fn: EndCheck): void {
  endCheck = fn;
}

/** The book's last file (its rel path) when this device's download of it lacks it
 * (`DownloadManifest.endsBefore`, D3, fe#185), once the launch has read the registry; else
 * undefined (not downloaded, or the download holds the book's end). Rejects while the
 * registry is not read (not known). */
export function downloadEndsBefore(
  connectionId: string,
  libraryId: number,
  path: string,
): Promise<string | undefined> {
  return endCheck(connectionId, libraryId, path);
}

type LengthCheck = (
  connectionId: string,
  libraryId: number,
  path: string,
) => Promise<number | undefined>;

let lengthCheck: LengthCheck = async () => undefined;

/** The downloads store's length check (`src/downloads/store.ts`). */
export function setDownloadLengthCheck(fn: LengthCheck): void {
  lengthCheck = fn;
}

/** When this device's download of the book ends before the book does (`endsBefore`), the
 * book's length on its server (seconds, `DownloadManifest.bookDuration`), 0 when that is not
 * known; once the launch has read the registry. Undefined for any other book. */
export function downloadBookLength(
  connectionId: string,
  libraryId: number,
  path: string,
): Promise<number | undefined> {
  return lengthCheck(connectionId, libraryId, path);
}

type KeptMetaRefresh = (
  connectionId: string,
  libraryId: number,
  path: string,
  job: number,
) => Promise<void>;

let keptMetaRefresh: KeptMetaRefresh = async () => {};

/** The downloads store's refresh of a book's kept metadata (`src/downloads/store.ts`). */
export function setKeptMetaRefresh(fn: KeptMetaRefresh): void {
  keptMetaRefresh = fn;
}

/** Keep a downloaded book's community metadata again now (after a Bridge job that made its
 * characters, recaps or description finished: `refreshAfterFinish`), rather than at the
 * launch a week on. `job` is that job's id: the copy is kept again once for it, not at
 * every launch that reads the job done. Nothing for a book not downloaded; best effort,
 * never rejects. */
export function refreshKeptMeta(
  connectionId: string,
  libraryId: number,
  path: string,
  job: number,
) {
  return keptMetaRefresh(connectionId, libraryId, path, job).catch(() => {});
}
