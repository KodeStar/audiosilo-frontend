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

/** Which sign-in needs attention when this connection's own /server query failed. */
export function refusedServer(
  connectionId: string,
  serverError: unknown,
): RefusedServer | undefined {
  return serverError instanceof ApiError &&
    (serverError.status === 401 || serverError.status === 403)
    ? { connectionId, proxy: serverError.fromProxy }
    : undefined;
}
