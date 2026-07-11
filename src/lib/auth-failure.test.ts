import { qk } from '@/api/hooks';

import { connectionIdFromKey, isServerInfoKey, serverResetCid } from './auth-failure';

// The dead-token 401-vs-403/network invariant is tested at its real seam: the ApiClient
// `onAuthError` cases in `src/api/client.test.ts`.

describe('connectionIdFromKey', () => {
  const ids = ['srv-a', 'srv-b'];

  it('finds the id when the key leads with it', () => {
    expect(connectionIdFromKey(['libraries', 'srv-a'], ids)).toBe('srv-a');
    expect(connectionIdFromKey(['item', 'srv-b', 1, 'x'], ids)).toBe('srv-b');
  });

  it('finds the id when it is not at a fixed index', () => {
    // qk.allProgress → ['progress','all',cid]; qk.recent → ['books','recent',cid,limit]
    expect(connectionIdFromKey(['progress', 'all', 'srv-a'], ids)).toBe('srv-a');
    expect(connectionIdFromKey(['books', 'recent', 'srv-b', 48], ids)).toBe('srv-b');
  });

  it('returns null for a global/unscoped key', () => {
    expect(connectionIdFromKey(['something', 'else'], ids)).toBeNull();
    expect(connectionIdFromKey([], ids)).toBeNull();
  });

  it('ignores non-string key parts', () => {
    expect(connectionIdFromKey([1, 2, 3], ids)).toBeNull();
  });
});

describe('isServerInfoKey', () => {
  // Build the key via the real factory so a change to `qk.server`'s shape breaks this
  // test - that's the drift guard.
  it('is true for a qk.server key', () => {
    expect(isServerInfoKey(qk.server('srv-a'))).toBe(true);
  });

  it('is false for any non-server key', () => {
    expect(isServerInfoKey(qk.libraries('srv-a'))).toBe(false);
    expect(isServerInfoKey(['progress', 'all', 'srv-a'])).toBe(false);
    expect(isServerInfoKey([])).toBe(false);
  });
});

describe('serverResetCid', () => {
  const cid = 'srv-a';

  it('returns null when server_id still matches the connection id', () => {
    expect(serverResetCid(qk.server(cid), { server_id: cid })).toBeNull();
  });

  it('returns the cid when server_id differs (the install was rebuilt)', () => {
    expect(serverResetCid(qk.server(cid), { server_id: 'a-different-id' })).toBe(cid);
  });

  it('returns null when server_id is missing or empty', () => {
    expect(serverResetCid(qk.server(cid), {})).toBeNull();
    expect(serverResetCid(qk.server(cid), { server_id: '' })).toBeNull();
    expect(serverResetCid(qk.server(cid), undefined)).toBeNull();
  });

  it('returns null for a non-server key', () => {
    expect(serverResetCid(qk.libraries(cid), { server_id: 'a-different-id' })).toBeNull();
  });
});
