import { fireEvent, render, screen } from '@testing-library/react-native';

let mockParams: Record<string, string> = {};
const mockSetOptions = jest.fn();
const mockSetParams = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useNavigation: () => ({ setOptions: mockSetOptions }),
  router: { setParams: (p: object) => mockSetParams(p) },
}));

let mockLayout: 'phone' | 'tablet' | 'desktop' = 'phone';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
// The sections have their own suites: here, which one the hub shows and how.
jest.mock('@/components/journal/journal-screen', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    JournalScreen: ({ embedded }: { embedded?: boolean }) => (
      <Text>{`journal-section embedded=${String(!!embedded)}`}</Text>
    ),
  };
});
jest.mock('@/components/settings/settings-content', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    SettingsContent: ({ embedded }: { embedded?: boolean }) => (
      <Text>{`settings-section embedded=${String(!!embedded)}`}</Text>
    ),
  };
});

/* eslint-disable import/first */
import { useSubNav } from '@/components/shell/sub-nav-store';

import { YouHub } from './you-hub';
/* eslint-enable import/first */

/** The hub with these route params. */
const mount = async (params: Record<string, string> = {}) => {
  mockParams = params;
  await render(<YouHub />);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockLayout = 'phone';
  useSubNav.setState({ slots: {} });
});

describe('YouHub on a phone', () => {
  it('offers all five sections and opens Stats by default', async () => {
    await mount();
    for (const label of ['Stats', 'Year', 'Journal', 'Settings', 'Account']) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.getByLabelText('Stats')).toBeChecked();
    expect(screen.getByTestId('you-hub-stats')).toBeTruthy();
    // The large title (the stack header's) names the section.
    expect(mockSetOptions).toHaveBeenLastCalledWith({ title: 'Your listening' });
  });

  it('switches sections in place, dropping the Journal tab', async () => {
    await mount({ section: 'journal', tab: 'notes' });
    expect(screen.getByText('journal-section embedded=true')).toBeTruthy();
    expect(mockSetOptions).toHaveBeenLastCalledWith({ title: 'Journal' });
    await fireEvent.press(screen.getByLabelText('Settings'));
    expect(mockSetParams).toHaveBeenLastCalledWith({ section: 'settings', tab: undefined });
    await fireEvent.press(screen.getByLabelText('Stats'));
    expect(mockSetParams).toHaveBeenLastCalledWith({ section: undefined, tab: undefined });
  });

  it('opens Stats for an unknown section', async () => {
    await mount({ section: 'devices' });
    expect(screen.getByTestId('you-hub-stats')).toBeTruthy();
  });

  it('shows a calm placeholder for Account until it is wired in', async () => {
    await mount({ section: 'account' });
    expect(screen.getByText('This part of You is on its way.')).toBeTruthy();
  });
});

describe('YouHub on tablet and desktop', () => {
  it('publishes Stats, Year in listening and Journal to the sub-nav', async () => {
    mockLayout = 'desktop';
    await mount({ section: 'year' });
    const sections = useSubNav.getState().slots['(me)']?.sections;
    expect(sections?.options.map((o) => o.label)).toEqual([
      'Stats',
      'Year in listening',
      'Journal',
    ]);
    expect(sections?.value).toBe('year');
    // Nothing renders in place.
    expect(screen.queryByLabelText('Settings')).toBeNull();
  });

  it('still renders Settings for an old link, with its own heading', async () => {
    mockLayout = 'tablet';
    await mount({ section: 'settings' });
    expect(screen.getByText('settings-section embedded=false')).toBeTruthy();
    expect(useSubNav.getState().slots['(me)']?.sections?.value).toBe('settings');
  });
});
