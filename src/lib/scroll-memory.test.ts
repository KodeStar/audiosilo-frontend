import { clearScrollMemory, recallScroll, rememberScroll, scrollKey } from './scroll-memory';

describe('scroll-memory', () => {
  it('recalls a remembered offset by key', () => {
    const k = scrollKey(1, 'Authors/Asimov');
    rememberScroll(k, 320);
    expect(recallScroll(k)).toBe(320);
  });

  it('returns 0 for a location it has never seen', () => {
    expect(recallScroll(scrollKey(9, 'never/visited'))).toBe(0);
  });

  it('keys offsets independently per library and path', () => {
    rememberScroll(scrollKey(1, 'A'), 100);
    rememberScroll(scrollKey(2, 'A'), 200);
    rememberScroll(scrollKey(1, 'B'), 300);
    expect(recallScroll(scrollKey(1, 'A'))).toBe(100);
    expect(recallScroll(scrollKey(2, 'A'))).toBe(200);
    expect(recallScroll(scrollKey(1, 'B'))).toBe(300);
  });

  it('keeps the most recent offset for a location', () => {
    const k = scrollKey(5, 'x');
    rememberScroll(k, 50);
    rememberScroll(k, 75);
    expect(recallScroll(k)).toBe(75);
  });

  it('forgets every offset on clear, so re-entry starts at the top', () => {
    rememberScroll(scrollKey(1, 'A'), 100);
    rememberScroll(scrollKey(1, 'B'), 200);
    clearScrollMemory();
    expect(recallScroll(scrollKey(1, 'A'))).toBe(0);
    expect(recallScroll(scrollKey(1, 'B'))).toBe(0);
  });
});
