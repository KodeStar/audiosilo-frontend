import { act, render, screen } from '@testing-library/react-native';

jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => 'desktop',
}));

/* eslint-disable import/first */
import { setFontScale } from '@/testing/font-scale';

import { Greeting } from './greeting';
/* eslint-enable import/first */

const NOW = Date.parse('2026-10-27T12:00:00Z');

beforeEach(() => jest.useFakeTimers({ now: NOW }));
afterEach(() => jest.useRealTimers());

describe('Greeting', () => {
  it('moves the sync pill on with the clock rather than freezing', async () => {
    const at = new Date(NOW - 2 * 60_000).toISOString();
    await render(<Greeting name="Sam" sync={{ kind: 'synced', at }} servers={1} />);
    expect(screen.getByText('Progress synced 2 minutes ago')).toBeTruthy();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(screen.getByText('Progress synced 5 minutes ago')).toBeTruthy();
  });

  // fe#267: a pill's height is a minimum, so text grown past it (iOS AX5) is not cut in half.
  it('lets a pill grow with its words', async () => {
    const at = new Date(NOW).toISOString();
    try {
      await setFontScale(3);
      await render(<Greeting name="Sam" sync={{ kind: 'synced', at }} servers={1} />);
      const pill = String(screen.getByTestId('greeting-pill').props.className);
      expect(pill).toContain('min-h-[30px]');
      expect(pill).not.toMatch(/(^|\s)h-\[30px\]/);
    } finally {
      await setFontScale(1);
    }
  });
});
