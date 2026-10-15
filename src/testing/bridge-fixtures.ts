import type { BridgeEstimate, BridgeJob, ServerInfo, User } from '@/api/types';

/** A `sidecars.generate` job as the server sends it (every field), running unless `over`
 * says otherwise. */
export function bridgeJob(over: Partial<BridgeJob> = {}): BridgeJob {
  return {
    id: 1,
    kind: 'sidecars.generate',
    library_id: 1,
    path: 'Author/Book',
    params: { source: 'auto', contribute: 'local' },
    state: 'running',
    progress: null,
    result: null,
    error: '',
    requested_by: { id: 1, username: 'admin' },
    priority: 0,
    attempts: 1,
    lease_until: null,
    cancel_requested: false,
    created_at: '2026-10-15T09:00:00Z',
    updated_at: '2026-10-15T10:00:00Z',
    claimed_at: null,
    finished_at: null,
    ...over,
  };
}

/** The estimate for a book with nothing yet, read from its audio. */
export function bridgeEstimate(over: Partial<BridgeEstimate> = {}): BridgeEstimate {
  return {
    kind: 'sidecars.generate',
    library_id: 1,
    path: 'Author/Book',
    source: 'audio',
    duration_seconds: 36000,
    asr_hours: 2.5,
    agent_cost_usd: 16,
    subscription: false,
    agent_ready: true,
    writable: true,
    has: {
      community: { characters: false, recaps: false },
      local: { characters: false, recaps: false },
    },
    earlier: [],
    ...over,
  };
}

/** A server whose Bridge is online and offers `sidecars`, with community metadata on. */
export function bridgeServer(over: Partial<ServerInfo> = {}): ServerInfo {
  return {
    name: 'Hearthside',
    server_id: 's1',
    version: '2.4.0',
    api: 'v1',
    capabilities: {
      admin_ui: true,
      web_player: true,
      transcode: false,
      upload: false,
      websocket: false,
      metadata: true,
      bridge: true,
    },
    auth: { methods: [] },
    bridge: { version: '0.2.0', features: ['verify', 'sidecars'] },
    ...over,
  };
}

/** An admin account (no household fields: an ordinary one). */
export const ADMIN: User = {
  id: 1,
  username: 'admin',
  role: 'admin',
  disabled: false,
  has_password: true,
  has_recovery: false,
};
