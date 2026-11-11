/**
 * Facts of this device's downloads registry, for code the downloads store can't be
 * imported into (it imports the API hooks, which ask `isKeptOffline`: `fetchBookProgress`,
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
 * undefined (not downloaded, or the download holds the book's end). */
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
