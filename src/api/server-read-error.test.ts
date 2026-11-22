import { ApiError } from './client';
import { refusedServer } from './server-read-error';

describe('refusedServer', () => {
  it("names a 401 the server's own as a sign-in to renew", () => {
    expect(refusedServer('c', new ApiError(401, 'invalid or expired token'))).toEqual({
      connectionId: 'c',
      proxy: false,
    });
  });

  it("names a proxy's 401 as the proxy's", () => {
    const error = new ApiError(401, 'Unauthorized', undefined, undefined, true);
    expect(refusedServer('c', error)).toEqual({ connectionId: 'c', proxy: true });
  });

  // /server is public: a 403 with a server-shaped body is a gateway's, not a dead sign-in.
  it('names every 403 on /server as something in front of the server', () => {
    expect(refusedServer('c', new ApiError(403, 'blocked'))).toEqual({
      connectionId: 'c',
      proxy: true,
    });
  });

  it('is no refusal for any other failure', () => {
    expect(refusedServer('c', new ApiError(502, 'bad gateway'))).toBeUndefined();
    expect(refusedServer('c', new Error('offline'))).toBeUndefined();
  });
});
