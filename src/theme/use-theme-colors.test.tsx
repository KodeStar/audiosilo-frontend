import { act, renderHook } from '@testing-library/react-native';
import { Uniwind } from 'uniwind';

import { colors } from '@/theme/tokens';

import { useThemeColors } from './use-theme-colors';

describe('useThemeColors', () => {
  afterEach(() => {
    Uniwind.setTheme('system');
  });

  it('returns the resolved theme and follows a theme change', async () => {
    Uniwind.setTheme('light');
    const { result, unmount } = await renderHook(() => useThemeColors());
    expect(result.current).toBe(colors.light);
    expect(result.current.brand).toBe('#db2777');

    await act(async () => {
      Uniwind.setTheme('dark');
    });
    expect(result.current).toBe(colors.dark);
    expect(result.current.background).toBe('#0a0f1e');
    await unmount();
  });
});
