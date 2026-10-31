/**
 * The AsyncStorage keys of the documents that more than their owning store reads: the
 * launch steps that run before any store hydrates (`resetStaleStorage`, the connection
 * identity migration) read and rewrite them too, and must not import the stores (they
 * hydrate after, and pull in most of the app). One leaf module, importing nothing, so a
 * name can never drift between a store and the code that migrates it. The strings are
 * persisted: never change one.
 */

/** The session's connections (`src/stores/session.ts`). */
export const CONNECTIONS_KEY = 'audiosilo.connections';
/** The default connection's id. The string is the legacy `activeConnection` name, kept
 * stable so an existing install's persisted default survives the active -> default rename. */
export const DEFAULT_CONNECTION_KEY = 'audiosilo.activeConnection';
/** The downloads registry, keyed by `contentKey`; each entry has a `connectionId`. */
export const DOWNLOADS_KEY = 'audiosilo.downloads';
/** The progress mirror, keyed by `contentKey`; each value has a `connectionId`. */
export const PROGRESS_MIRROR_KEY = 'audiosilo.progressMirror';
/** The offline save queue: an array of saves, each with a `connectionId`. */
export const PROGRESS_QUEUE_KEY = 'audiosilo.progressQueue';
/** The ebook reading-place mirror (`src/reader/reading-progress.ts`), keyed by
 * `contentKey`; each value has a `connectionId`. */
export const READING_MIRROR_KEY = 'audiosilo.readingMirror';
/** The offline queue of ebook reading-place saves, each with a `connectionId`. */
export const READING_QUEUE_KEY = 'audiosilo.readingQueue';
/** The listening outbox (Sync v2, `src/playback/listening-outbox.ts`): an array of closed
 * listening events waiting to be sent, each with a `connectionId`. */
export const LISTENING_OUTBOX_KEY = 'audiosilo.listeningOutbox';
/** The one listening span being played (with its `connectionId`), or null: rewritten each
 * 15 s tick so a span a kill left open is closed at the next launch. */
export const LISTENING_OPEN_SPAN_KEY = 'audiosilo.listeningOpenSpan';
/** Per connection id: when its outbox last synced and the events it couldn't sync. */
export const LISTENING_SYNC_KEY = 'audiosilo.listeningSync';
/** Each connection's kept `/server` answer for offline reading, keyed by connection id. */
export const OFFLINE_SERVERS_KEY = 'audiosilo.offlineServers';
/** Web: the last answers the first screens paint from (`src/api/startup-cache.ts`), each
 * keyed by its query key (which carries the connection id). Disposable: a reset wipes it. */
export const STARTUP_CACHE_KEY = 'audiosilo.startupCache';
/** The car bookmarks to try again: an array, each with a `connectionId`. */
export const CAR_BOOKMARKS_KEY = 'audiosilo.carBookmarks';
/** Native keeps the car snapshot it was last handed; this says one was. */
export const CAR_SNAPSHOT_WRITTEN_KEY = 'audiosilo.carSnapshotWritten';
/** `{ selection: { connectionId, libraryId } }`. */
export const LIBRARY_SELECTION_KEY = 'audiosilo.librarySelection';
/** `{ lifetime, books }`, books keyed by `contentKey`. */
export const TIME_SAVED_KEY = 'audiosilo.timeSaved';
/** The drift-offs, keyed by `contentKey`. */
export const DRIFT_STORAGE_KEY = 'audiosilo.driftOffs';
/** `{ [legacyId]: newId }`, recorded by the identity migration (never wiped by a reset). */
export const CONNECTION_ALIASES_KEY = 'audiosilo.connectionAliases';
/** The profiles document (`src/stores/profiles.ts`; the identity migration writes the first). */
export const PROFILES_KEY = 'audiosilo.profiles';

/** A plain object (not null, not an array): the first check of every stored document's
 * parser. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
