// scroll-memory registers an onConnectionRemoved purge at import; mock the session
// store so we can capture and drive that callback directly (it's the only thing the
// module pulls from the store).
jest.mock('@/stores/session', () => ({
  onConnectionRemoved: jest.fn(() => () => {}),
}));

/* eslint-disable import/first */
import { onConnectionRemoved } from '@/stores/session';

import { clearScrollMemory, recallScroll, rememberScroll, scrollKey } from './scroll-memory';
/* eslint-enable import/first */

// The purge callback scroll-memory registered at import.
const removalCleanup = (onConnectionRemoved as jest.Mock).mock.calls[0]?.[0] as (
  id: string,
) => void;

describe('scroll-memory', () => {
  beforeEach(() => clearScrollMemory());

  it('recalls a remembered offset by key', () => {
    const k = scrollKey('c1', 1, 'Authors/Asimov');
    rememberScroll(k, 320);
    expect(recallScroll(k)).toBe(320);
  });

  it('returns 0 for a location it has never seen', () => {
    expect(recallScroll(scrollKey('c1', 9, 'never/visited'))).toBe(0);
  });

  it('keys offsets independently per library and path', () => {
    rememberScroll(scrollKey('c1', 1, 'A'), 100);
    rememberScroll(scrollKey('c1', 2, 'A'), 200);
    rememberScroll(scrollKey('c1', 1, 'B'), 300);
    expect(recallScroll(scrollKey('c1', 1, 'A'))).toBe(100);
    expect(recallScroll(scrollKey('c1', 2, 'A'))).toBe(200);
    expect(recallScroll(scrollKey('c1', 1, 'B'))).toBe(300);
  });

  it('scopes the same (library, path) independently per connection', () => {
    // Two servers, same (libraryId, path): the keys must differ and not restore each
    // other's offset.
    expect(scrollKey('c1', 1, 'A')).not.toBe(scrollKey('c2', 1, 'A'));
    rememberScroll(scrollKey('c1', 1, 'A'), 100);
    rememberScroll(scrollKey('c2', 1, 'A'), 200);
    expect(recallScroll(scrollKey('c1', 1, 'A'))).toBe(100);
    expect(recallScroll(scrollKey('c2', 1, 'A'))).toBe(200);
  });

  it('keeps the most recent offset for a location', () => {
    const k = scrollKey('c1', 5, 'x');
    rememberScroll(k, 50);
    rememberScroll(k, 75);
    expect(recallScroll(k)).toBe(75);
  });

  it('forgets every offset on clear, so re-entry starts at the top', () => {
    rememberScroll(scrollKey('c1', 1, 'A'), 100);
    rememberScroll(scrollKey('c1', 1, 'B'), 200);
    clearScrollMemory();
    expect(recallScroll(scrollKey('c1', 1, 'A'))).toBe(0);
    expect(recallScroll(scrollKey('c1', 1, 'B'))).toBe(0);
  });

  it('onConnectionRemoved drops only that connection’s remembered offsets', () => {
    rememberScroll(scrollKey('c1', 1, 'A'), 100);
    rememberScroll(scrollKey('c1', 2, 'B'), 150);
    rememberScroll(scrollKey('c2', 1, 'A'), 200);

    removalCleanup('c1');

    expect(recallScroll(scrollKey('c1', 1, 'A'))).toBe(0);
    expect(recallScroll(scrollKey('c1', 2, 'B'))).toBe(0);
    expect(recallScroll(scrollKey('c2', 1, 'A'))).toBe(200); // the other server survives
  });
});
