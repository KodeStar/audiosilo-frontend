import { Directory, File, Paths } from 'expo-file-system';

/**
 * The covers the car shows for books that are not downloaded (a downloaded book's own
 * cover file is used as it is): one small JPEG per book under the app's document folder
 * (`car-artwork/`), so CarPlay and Android Auto read FILES the app wrote (no cover URL, and
 * so no session token, ever reaches the car snapshot), and a car that connects offline still
 * has them. A file is named from a hash of the book's `contentKey` and its `cover_version`, so
 * a new cover is a new file; each is written at most once (downloaded to a `.part` file and
 * moved into place only when complete) and pruned once no snapshot names it.
 *
 * Native only (the controller never starts on the web).
 */

const CAR_ARTWORK_DIR = 'car-artwork';

function artworkDir(): Directory {
  return new Directory(Paths.document, CAR_ARTWORK_DIR);
}

/** FNV-1a 32-bit, hex. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** djb2 32-bit, hex (a second hash, so two books need both to collide to share a file). */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** The file name of a book's car cover: a hash of its content key and cover version. */
export function artworkName(contentKey: string, coverVersion?: string): string {
  const s = `${contentKey}\n${coverVersion ?? ''}`;
  return `${fnv1a(s)}${djb2(s)}.jpg`;
}

/** Where a car cover lives (whether or not it has been written yet). */
function artworkFile(name: string): File {
  return new File(artworkDir(), name);
}

/** The `file://` URI of a car cover already on disk, else null. Never touches the network. */
export function existingArtwork(name: string): string | null {
  try {
    const file = artworkFile(name);
    return file.exists ? file.uri : null;
  } catch {
    return null;
  }
}

const inFlight = new Map<string, Promise<string | null>>();

/** After a cover couldn't be written (offline, a timeout), wait this long before asking for it
 * again, doubling with each failure up to `MAX_RETRY_MS`. */
export const RETRY_MS = 60_000;
export const MAX_RETRY_MS = 30 * 60_000;

/**
 * Covers that could not be written this session, by file name (a hash of the content key and
 * the cover version, so a new cover is a new name and is asked at once). Without it every
 * snapshot write asked the server again for each cover it lacks: a library whose covers 404
 * logged a warning per book per write. Kept in memory only: a new session asks once more.
 */
const failures = new Map<string, { count: number; retryAt: number }>();

/** The server says the book has no cover (404, 410): asking again this session won't change
 * the answer. Any other failure (offline, a 401 before a new sign-in, a 5xx) may pass later.
 * expo-file-system rejects with "response has status: 404" (Android) / "response has status
 * 404" (iOS). */
function noCover(err: unknown): boolean {
  const m = /response has status:?\s*(\d{3})/.exec(
    err instanceof Error ? err.message : String(err),
  );
  return m?.[1] === '404' || m?.[1] === '410';
}

/** Remember a failed cover; true for its first failure this session (the one worth a log). */
function noteFailure(name: string, permanent: boolean): boolean {
  const had = failures.get(name);
  const count = (had?.count ?? 0) + 1;
  const wait = Math.min(RETRY_MS * 2 ** (count - 1), MAX_RETRY_MS);
  failures.set(name, { count, retryAt: permanent ? Infinity : Date.now() + wait });
  return !had;
}

/**
 * Write a car cover once: `existingArtwork` when it is there; else download it from `url`
 * (a server cover; it lands in a `.part` file first, so a failed or interrupted download
 * never leaves a broken cover that counts as written). Resolves the file URI, or null when
 * it couldn't be written (offline, no cover on the server): the item then shows no cover. A
 * failed cover is not asked again on every snapshot (`failures`): one the server has none for
 * (404) is not asked again this session, any other failure waits `RETRY_MS`, doubling up to
 * `MAX_RETRY_MS`. A second call for the same name while one runs shares it.
 */
export function ensureArtwork(name: string, url: string): Promise<string | null> {
  const existing = existingArtwork(name);
  if (existing) return Promise.resolve(existing);
  const failed = failures.get(name);
  if (failed && Date.now() < failed.retryAt) return Promise.resolve(null);
  const running = inFlight.get(name);
  if (running) return running;
  const job = write(name, url).finally(() => inFlight.delete(name));
  inFlight.set(name, job);
  return job;
}

async function write(name: string, url: string): Promise<string | null> {
  try {
    const dir = artworkDir();
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const dest = artworkFile(name);
    const part = new File(dir, `${name}.part`);
    if (part.exists) part.delete();
    await File.downloadFileAsync(url, part, { idempotent: true });
    if (!part.exists || (part.size ?? 0) <= 0) {
      if (part.exists) part.delete();
      // An empty answer is the server's own: a book with no cover.
      noteFailure(name, true);
      return null;
    }
    if (dest.exists) dest.delete();
    part.move(dest);
    failures.delete(name);
    return dest.uri;
  } catch (err) {
    if (noteFailure(name, noCover(err))) console.warn('[car] cover not written', err);
    return null;
  }
}

/** Delete every car cover (and leftover `.part` file) whose name is not in `keep`, except
 * those being written now. Best effort. */
export function pruneArtwork(keep: ReadonlySet<string>): void {
  try {
    const dir = artworkDir();
    if (!dir.exists) return;
    for (const item of dir.list()) {
      if (!(item instanceof File)) continue;
      const name = item.name;
      const base = name.endsWith('.part') ? name.slice(0, -'.part'.length) : name;
      if (keep.has(base) || inFlight.has(base)) continue;
      try {
        item.delete();
      } catch {
        // best effort
      }
    }
  } catch {
    // best effort: a cover left behind is only wasted space
  }
}
