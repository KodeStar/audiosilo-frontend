import { fireEvent, render, screen } from '@testing-library/react-native';
import { Dimensions } from 'react-native';

let mockBadge: { supported: boolean | undefined; count: number } = { supported: true, count: 4 };
jest.mock('./use-up-next', () => ({ useUpNextBadge: () => mockBadge }));
let mockLayout: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));

/* eslint-disable import/first */
import { badgeText, UpNextButton } from './up-next-button';
import { usePlayerSheets } from '@/components/player/player-sheets';
import { expectNativeTarget } from '@/testing/touch-target';

import { useUpNext } from './up-next-store';
/* eslint-enable import/first */

const setWidth = (width: number) =>
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width, height: 900, scale: 1, fontScale: 1 });

beforeEach(() => {
  mockBadge = { supported: true, count: 4 };
  mockLayout = 'desktop';
  useUpNext.setState({ drawerOpen: true });
  usePlayerSheets.setState({ open: null });
});
afterEach(() => jest.restoreAllMocks());

describe('UpNextButton', () => {
  it('renders nothing until the server is known to have Up next', async () => {
    mockBadge = { supported: undefined, count: 0 };
    const unknown = await render(<UpNextButton variant="bar" />);
    expect(unknown.toJSON()).toBeNull();
    mockBadge = { supported: false, count: 0 };
    const off = await render(<UpNextButton variant="bar" />);
    expect(off.toJSON()).toBeNull();
  });

  it('shows the count and toggles the drawer on a desktop', async () => {
    setWidth(1440);
    await render(<UpNextButton variant="bar" />);
    expect(screen.getByText('4', { includeHiddenElements: true })).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Up next, 4 books' });
    await fireEvent.press(button);
    expect(useUpNext.getState().drawerOpen).toBe(false);
  });

  it('opens the sheet on a phone, and the dock carries no count', async () => {
    setWidth(400);
    mockLayout = 'phone';
    await render(<UpNextButton variant="header" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Up next, 4 books' }));
    expect(usePlayerSheets.getState().open).toBe('upnext');

    await render(<UpNextButton variant="dock" />);
    expect(screen.queryByText('4', { includeHiddenElements: true })).toBeNull();
    mockBadge = { supported: true, count: 0 };
    await render(<UpNextButton variant="bar" />);
    expect(screen.getByRole('button', { name: 'Up next' })).toBeTruthy();
  });

  // The header's 2.75 rem circle is 38.5 pt on native (a 14 pt rem).
  it('takes a 44 pt touch on native in every form', async () => {
    for (const variant of ['header', 'bar', 'dock'] as const) {
      const view = await render(<UpNextButton variant={variant} />);
      expectNativeTarget(screen.getByTestId(`upnext-button-${variant}`));
      await view.unmount();
    }
  });

  it('caps the badge', () => {
    expect(badgeText(7)).toBe('7');
    expect(badgeText(250)).toBe('99+');
  });
});
