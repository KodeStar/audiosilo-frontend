import { fireEvent, render, screen } from '@testing-library/react-native';

let mockDownloads = { hydrated: false, supported: true };
jest.mock('@/downloads/store', () => ({
  useDownloads: (sel: (s: typeof mockDownloads) => unknown) => sel(mockDownloads),
}));
jest.mock('@/downloads/keep-ahead-controller', () => ({
  useKeepAhead: (sel: (s: { status: string }) => unknown) => sel({ status: 'ready' }),
}));

/* eslint-disable import/first */
import { useSettings } from '@/stores/settings';

import { KeepAheadCard } from './keep-ahead-card';
/* eslint-enable import/first */

beforeEach(() => {
  useSettings.setState({ keepAhead: 0, autoDownloadNext: 'wifi' });
});

describe('KeepAheadCard', () => {
  it('shows nothing until the downloads store knows, nor where downloads are unsupported', async () => {
    mockDownloads = { hydrated: false, supported: true };
    const r = await render(<KeepAheadCard />);
    expect(r.toJSON()).toBeNull();
    mockDownloads = { hydrated: true, supported: false };
    await r.rerender(<KeepAheadCard />);
    expect(r.toJSON()).toBeNull();
  });

  it('sets the same keep-ahead setting as the Downloads page and shows its status', async () => {
    mockDownloads = { hydrated: true, supported: true };
    await render(<KeepAheadCard />);
    expect(screen.getByText('Keep ahead offline')).toBeTruthy();
    await fireEvent.press(screen.getByRole('radio', { name: '2' }));
    expect(useSettings.getState().keepAhead).toBe(2);
    expect(screen.getByText('The next books are ready offline.')).toBeTruthy();
  });
});
