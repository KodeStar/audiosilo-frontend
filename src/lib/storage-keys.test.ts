import * as keys from './storage-keys';
import { isRecord } from './storage-keys';

describe('storage keys', () => {
  it('keep the names installs have persisted under', () => {
    const { isRecord: _guard, ...names } = keys;
    expect(names).toEqual({
      CONNECTIONS_KEY: 'audiosilo.connections',
      DEFAULT_CONNECTION_KEY: 'audiosilo.activeConnection',
      DOWNLOADS_KEY: 'audiosilo.downloads',
      PROGRESS_MIRROR_KEY: 'audiosilo.progressMirror',
      PROGRESS_QUEUE_KEY: 'audiosilo.progressQueue',
      READING_MIRROR_KEY: 'audiosilo.readingMirror',
      READING_QUEUE_KEY: 'audiosilo.readingQueue',
      LISTENING_OUTBOX_KEY: 'audiosilo.listeningOutbox',
      LISTENING_OPEN_SPAN_KEY: 'audiosilo.listeningOpenSpan',
      LISTENING_SYNC_KEY: 'audiosilo.listeningSync',
      OFFLINE_SERVERS_KEY: 'audiosilo.offlineServers',
      STARTUP_CACHE_KEY: 'audiosilo.startupCache',
      CAR_BOOKMARKS_KEY: 'audiosilo.carBookmarks',
      CAR_SNAPSHOT_WRITTEN_KEY: 'audiosilo.carSnapshotWritten',
      LIBRARY_SELECTION_KEY: 'audiosilo.librarySelection',
      TIME_SAVED_KEY: 'audiosilo.timeSaved',
      DRIFT_STORAGE_KEY: 'audiosilo.driftOffs',
      CONNECTION_ALIASES_KEY: 'audiosilo.connectionAliases',
      PROFILES_KEY: 'audiosilo.profiles',
    });
  });

  it('isRecord takes plain objects only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    for (const v of [null, undefined, [], 'x', 3, true]) expect(isRecord(v)).toBe(false);
  });
});
