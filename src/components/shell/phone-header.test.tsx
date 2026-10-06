import { render, screen } from '@testing-library/react-native';

jest.mock('@/components/layout/offline-banner', () => ({ OfflineBanner: () => null }));
jest.mock('@/components/layout/reconnect-banner', () => ({ ReconnectBanner: () => null }));
jest.mock('@/components/upnext/up-next-button', () => ({ UpNextButton: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

/* eslint-disable import/first */
import { PhoneHeader } from './phone-header';
/* eslint-enable import/first */

describe('PhoneHeader', () => {
  it('sets a pushed page apart from what scrolls under it with a hairline', async () => {
    await render(<PhoneHeader title="" backTitle="" onBack={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    const bar = String(screen.getByTestId('phone-header-bar').props.className);
    expect(bar).toContain('border-b');
    expect(bar).toContain('border-border');
  });

  it('gives a tab root its large title, with no back button', async () => {
    await render(<PhoneHeader title="Library" onBack={jest.fn()} />);
    expect(screen.getByRole('header', { name: 'Library' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });
});
