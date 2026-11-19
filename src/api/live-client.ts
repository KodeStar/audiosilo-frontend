import type { ApiClient } from './client';
import { resolveClient } from './connection-clients';

/**
 * The `ApiClient` for a connection id that reads the connection again at each use, or null
 * when that connection does not exist now. For a caller that takes a client and sends
 * through it only after awaits of its own (the save loop's `saveProgress` writes this
 * device's record and may check a guard first): a re-pair meanwhile changes the token, and
 * a client taken before it would send the old one, be refused (401) and lose the save. Each
 * method is looked up on the connection's client at that moment (`resolveClient`), so a
 * request goes with the token and the address the connection has when it is sent. A
 * connection gone by then keeps the last client it had: what a client taken up front would
 * have sent.
 *
 * Its own module, beside `connection-clients.ts` rather than in it: built on
 * `resolveClient`, so a test that stands in for that one gets this over its stand-in.
 */
export function liveClient(connectionId: string): ApiClient | null {
  const first = resolveClient(connectionId);
  if (!first) return null;
  let last: ApiClient = first;
  return new Proxy(first, {
    get(_held, prop) {
      last = resolveClient(connectionId) ?? last;
      const value: unknown = Reflect.get(last, prop, last);
      return typeof value === 'function' ? value.bind(last) : value;
    },
  });
}
