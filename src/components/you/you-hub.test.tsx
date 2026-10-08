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
jest.mock('@/components/you/stats/stats-section', () => {
  const { Text } = jest.requireActual('react-native');
  return { StatsSection: () => <Text>stats-section</Text> };
});
jest.mock('@/components/you/year/year-section', () => {
  const { Text } = jest.requireActual('react-native');
  return { YearSection: () => <Text>year-section</Text> };
});
jest.mock('@/components/account/account-section', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    AccountSection: ({ connectionId }: { connectionId?: string }) => (
      <Text>{`account-section connection=${connectionId ?? 'default'}`}</Text>
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
    expect(screen.getByText('stats-section')).toBeTruthy();
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

  it("renders the Year section and the default server's Account", async () => {
    await mount({ section: 'year' });
    expect(screen.getByText('year-section')).toBeTruthy();
    expect(mockSetOptions).toHaveBeenLastCalledWith({ title: 'Year in listening' });
    await mount({ section: 'account' });
    // No connection: the section picks the default server (with its own switcher).
    expect(screen.getByText('account-section connection=default')).toBeTruthy();
  });
});

describe('YouHub scrolling', () => {
  it.each(['stats', 'year', 'account'])(
    "insets the %s section's scroller for the iOS tab bar itself",
    async (section) => {
      // The scroller sits under the segmented control, where react-native-screens'
      // first-descendant search never finds it: without this the end of the page (Add a
      // server, the version line) scrolled under the tab bar.
      await mount({ section });
      expect(screen.getByTestId('you-hub-scroll').props.contentInsetAdjustmentBehavior).toBe(
        'automatic',
      );
    },
  );

  it('starts a new section at its top (a fresh scroller), keeping the same one otherwise', async () => {
    await mount({ section: 'account' });
    const first = screen.getByTestId('you-hub-scroll');
    await screen.rerender(<YouHub />);
    expect(screen.getByTestId('you-hub-scroll')).toBe(first);
    mockParams = { section: 'stats' };
    await screen.rerender(<YouHub />);
    expect(screen.getByTestId('you-hub-scroll')).not.toBe(first);
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
