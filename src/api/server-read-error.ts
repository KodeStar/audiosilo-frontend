import { ApiError } from './client';

/** The feature could not be checked because its connection's /server read failed.
 * Resource readers may interpret their own 404 or 403 as a missing or forbidden item. */
export class ServerReadError extends Error {
  constructor(readonly cause: Error) {
    super('Could not read server capabilities');
    this.name = 'ServerReadError';
  }
}

export type RefusedServer = { connectionId: string; proxy: boolean };

/** Which sign-in needs attention when this connection's own /server query failed. The
 * server answers /server to anyone, so a 403 there is never its own: whatever its body,
 * something in front turned the device away, and signing in to AudioSilo again can't help.
 * A 401 read as the server's (`fromProxy` false) has already flagged the sign-in. */
export function refusedServer(
  connectionId: string,
  serverError: unknown,
): RefusedServer | undefined {
  if (!(serverError instanceof ApiError)) return undefined;
  if (serverError.status === 403) return { connectionId, proxy: true };
  return serverError.status === 401 ? { connectionId, proxy: serverError.fromProxy } : undefined;
}
