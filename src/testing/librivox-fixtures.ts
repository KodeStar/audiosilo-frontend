import type { BridgeJob, LibrivoxHit, LibrivoxRecording, ServerInfo } from '@/api/types';

import { bridgeJob, bridgeServer } from './bridge-fixtures';

/** A server whose Bridge is online and runs `librivox.fetch`, with community metadata on. */
export function librivoxServer(over: Partial<ServerInfo> = {}): ServerInfo {
  return bridgeServer({
    bridge: { version: '0.7.0', features: ['verify', 'sidecars', 'librivox'] },
    ...over,
  });
}

/** A LibriVox search hit as the server sends it. */
export function librivoxHit(over: Partial<LibrivoxHit> = {}): LibrivoxHit {
  return {
    work_id: 'johnny-crows-garden',
    title: "Johnny Crow's Garden",
    authors: [{ id: 'l-leslie-brooke', name: 'L. Leslie Brooke' }],
    language: 'en',
    release_date: '2006',
    ...over,
  };
}

/** A LibriVox recording of a work as the server sends it: not on this server, no job. */
export function librivoxRecording(over: Partial<LibrivoxRecording> = {}): LibrivoxRecording {
  return {
    recording_id: 'johnny-crows-garden-librivox-192',
    librivox_id: 192,
    narrators: [{ id: 'kara-shallenberg', name: 'Kara Shallenberg' }],
    runtime_min: 12,
    chapter_count: 3,
    cover_url: 'https://archive.org/download/johnny/cover.jpg',
    url: 'https://librivox.org/johnny-crows-garden-by-l-leslie-brooke/',
    in_library: [],
    job: null,
    ...over,
  };
}

/** A `librivox.fetch` job as the server sends it (no book path), running unless `over`
 * says otherwise. */
export function librivoxJob(over: Partial<BridgeJob> = {}): BridgeJob {
  return bridgeJob({
    id: 41,
    kind: 'librivox.fetch',
    library_id: 3,
    path: null,
    params: {
      librivox_id: 192,
      work_id: 'johnny-crows-garden',
      recording_id: 'johnny-crows-garden-librivox-192',
      library_id: 3,
    },
    ...over,
  });
}
