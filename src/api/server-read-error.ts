import { ApiError } from './client';

/** The feature could not be checked because its connection's /server read failed.
 * Resource readers may interpret their own 404 or 403 as a missing or forbidden item. */
export class ServerReadError extends Error {
  constructor(readonly cause: Error) {
    super('Could not read server capabilities');
    this.name = 'ServerReadError';
  }
}

/** A refusal to read /server that needs attention before a gated read can run. */
export function serverAccessRefusal(error: unknown): ApiError | null {
  return error instanceof ServerReadError ? accessRefusal(error.cause) : null;
}

function accessRefusal(error: unknown): ApiError | null {
  return error instanceof ApiError && (error.status === 401 || error.status === 403) ? error : null;
}

export type RefusedServer = { connectionId: string; proxy: boolean };

/** Which sign-in needs attention when this connection's own /server query failed. */
export function refusedServer(
  connectionId: string,
  serverError: unknown,
): RefusedServer | undefined {
  const refusal = accessRefusal(serverError);
  return refusal ? { connectionId, proxy: refusal.fromProxy } : undefined;
}
