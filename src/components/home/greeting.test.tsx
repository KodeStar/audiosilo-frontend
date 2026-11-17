import { act, render, screen } from '@testing-library/react-native';

jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
let mockLayout = 'desktop';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));

/* eslint-disable import/first */
import { setFontScale } from '@/testing/font-scale';

import { Greeting } from './greeting';
/* eslint-enable import/first */

const NOW = Date.parse('2026-10-27T12:00:00Z');

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  mockLayout = 'desktop';
});
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

  // fe#267: a pill's height is a minimum, so text grown past it (iOS AX5) is not cut in
  // half, and a pill whose words wrap rounds less.
  it('lets a pill grow with its words', async () => {
    const at = new Date(NOW).toISOString();
    const pill = () => String(screen.getByTestId('greeting-pill').props.className);
    await render(<Greeting name="Sam" sync={{ kind: 'synced', at }} servers={1} />);
    expect(pill()).toContain('rounded-full');
    try {
      await setFontScale(3);
      await render(<Greeting name="Sam" sync={{ kind: 'synced', at }} servers={1} />);
      expect(pill()).toContain('min-h-[30px]');
      expect(pill()).not.toMatch(/(^|\s)h-\[30px\]/);
      expect(pill()).toContain('rounded-2xl');
    } finally {
      await setFontScale(1);
    }
  });

  // fe#147: on a phone the long "Saved on this device, will sync" goes under the date, which
  // it cut beside it; the short "Synced ..." stays on the date's row.
  it("puts a phone's waiting-save pill under the date, the synced one beside it", async () => {
    mockLayout = 'phone';
    const pillRow = () => screen.getByTestId('greeting-pill').parent;
    const dateRow = () => screen.getByText(/October/).parent;
    await render(<Greeting name="Sam" sync={{ kind: 'local' }} servers={1} />);
    expect(screen.getByText('Saved on this device, will sync')).toBeTruthy();
    expect(pillRow()).not.toBe(dateRow());
    await render(
      <Greeting
        name="Sam"
        sync={{ kind: 'synced', at: new Date(NOW).toISOString() }}
        servers={1}
      />,
    );
    expect(pillRow()).toBe(dateRow());
  });
});
