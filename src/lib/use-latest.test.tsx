import { renderHook } from '@testing-library/react-native';

import { useLatest, useLatestRef } from '@/lib/use-latest';

describe('useLatest', () => {
  it('keeps one function that calls the latest closure', async () => {
    const { result, rerender } = await renderHook(({ n }: { n: number }) => useLatest(() => n), {
      initialProps: { n: 1 },
    });
    const first = result.current;
    expect(first()).toBe(1);
    await rerender({ n: 2 });
    expect(result.current).toBe(first);
    expect(first()).toBe(2);
  });

  it('keeps a ref on the latest value', async () => {
    const { result, rerender } = await renderHook(({ v }: { v: string }) => useLatestRef(v), {
      initialProps: { v: 'a' },
    });
    await rerender({ v: 'b' });
    expect(result.current.current).toBe('b');
  });
});
