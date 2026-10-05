import { renderHook } from '@testing-library/react-native';

import { useDomId } from './use-dom-id';

describe('useDomId', () => {
  it('is prefixed, DOM-safe, stable per instance and unique across instances', async () => {
    const a = await renderHook(() => useDomId('field'));
    const b = await renderHook(() => useDomId('field'));
    expect(a.result.current).toMatch(/^field-[a-zA-Z0-9_-]+$/);
    const first = a.result.current;
    await a.rerender({});
    expect(a.result.current).toBe(first);
    expect(b.result.current).not.toBe(first);
  });
});
