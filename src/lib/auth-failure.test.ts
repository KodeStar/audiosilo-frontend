import { ApiError, TimeoutError } from '@/api/client';

import { connectionIdFromKey, isDeadTokenError } from './auth-failure';

describe('isDeadTokenError', () => {
  it('is true for a 401 ApiError (server answered, token rejected)', () => {
    // A genuinely dead/invalid/revoked token always yields 401 on audiosilo-server
    // (middleware.go "missing bearer token" / "invalid or expired token").
    expect(isDeadTokenError(new ApiError(401, 'invalid or expired token'))).toBe(true);
  });

  it('is FALSE for a 403 scope/share denial - the token is still valid, not dead', () => {
    // Regression guard: the server returns 403 for "valid token, but forbidden" -
    // handlers_library.go "no access to this library"/"no access to this path" (a routine
    // event when a scoped/shared user browses outside their share), "admin only", and
    // api-key/demo restrictions. Flagging reconnect on these would spuriously log out a
    // correctly-authenticated user - the exact false-positive this feature must avoid.
    expect(isDeadTokenError(new ApiError(403, 'no access to this path'))).toBe(false);
    expect(isDeadTokenError(new ApiError(403, 'no access to this library'))).toBe(false);
    expect(isDeadTokenError(new ApiError(403, 'admin only'))).toBe(false);
  });

  it('is false for other HTTP statuses (500, 404, 400)', () => {
    expect(isDeadTokenError(new ApiError(500, 'boom'))).toBe(false);
    expect(isDeadTokenError(new ApiError(404, 'nope'))).toBe(false);
    expect(isDeadTokenError(new ApiError(400, 'bad'))).toBe(false);
  });

  it('is false for a network/offline failure (no HTTP response)', () => {
    // A raw fetch rejection or a TimeoutError is "offline", never a dead token.
    expect(isDeadTokenError(new TimeoutError(15000))).toBe(false);
    expect(isDeadTokenError(new TypeError('Network request failed'))).toBe(false);
    expect(isDeadTokenError(undefined)).toBe(false);
    expect(isDeadTokenError('nope')).toBe(false);
  });
});

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

  it('accepts a Set of known ids', () => {
    expect(connectionIdFromKey(['server', 'srv-a'], new Set(ids))).toBe('srv-a');
  });

  it('ignores non-string key parts', () => {
    expect(connectionIdFromKey([1, 2, 3], ids)).toBeNull();
  });
});
