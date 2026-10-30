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
  const { Pressable, Text } = jest.requireActual('react-native');
  return {
    SettingsContent: ({
      embedded,
      onOpenHousehold,
    }: {
      embedded?: boolean;
      onOpenHousehold?: () => void;
    }) => (
      <>
        <Text>{`settings-section embedded=${String(!!embedded)}`}</Text>
        {onOpenHousehold ? (
          <Pressable testID="settings-open-household" onPress={onOpenHousehold} />
        ) : null}
      </>
    ),
  };
});
jest.mock('@/components/household/household-page', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    HouseholdPage: ({ embedded }: { embedded?: boolean }) => (
      <Text>{`household-section embedded=${String(!!embedded)}`}</Text>
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

// Whether a server offers Upcoming to the listener (Track U2): `useUpcomingAvailable` has
// its own suite; the section's body is the Upcoming page's (its own suite too).
let mockUpcomingAvailable: boolean | undefined;
jest.mock('@/api/hooks', () => ({ useUpcomingAvailable: () => mockUpcomingAvailable }));
jest.mock('@/components/upcoming/upcoming-screen', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    UpcomingContent: ({ embedded }: { embedded?: boolean }) => (
      <Text>{`upcoming-section embedded=${String(!!embedded)}`}</Text>
    ),
  };
});

// Which modules are on (Bridge Phase 2a): `useActiveModules` has its own suite; here a
// module's flag is on when `mockModulesOn` says so.
let mockModulesOn: Record<string, boolean> = {};
const mockUseActiveModules = jest.fn();
jest.mock('@/modules/registry', () => ({
  ...jest.requireActual('@/modules/registry'),
  useActiveModules: (list: readonly { id: string }[]) => {
    mockUseActiveModules();
    return list.filter((m) => mockModulesOn[m.id]);
  },
}));

/* eslint-disable import/first */
import { Text } from 'react-native';

import { useSubNav } from '@/components/shell/sub-nav-store';
import type { PlayerModule } from '@/modules/registry';

import { YouHub } from './you-hub';
/* eslint-enable import/first */

/** The hub with these route params. */
const mount = async (params: Record<string, string> = {}) => {
  mockParams = params;
  await render(<YouHub />);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockModulesOn = {};
  mockUpcomingAvailable = false;
  mockLayout = 'phone';
  useSubNav.setState({ slots: {} });
});

describe('YouHub on a phone', () => {
  it('offers all six sections and opens Stats by default', async () => {
    await mount();
    for (const label of ['Stats', 'Year', 'Journal', 'Settings', 'Household', 'Account']) {
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

describe('YouHub Household (Phase 8b-1)', () => {
  it('is the sixth segment, between Settings and Account, embedded under the large title', async () => {
    await mount({ section: 'household' });
    const labels = screen.getAllByRole('radio').map((r) => r.props.accessibilityLabel);
    expect(labels).toEqual(['Stats', 'Year', 'Journal', 'Settings', 'Household', 'Account']);
    expect(screen.getByLabelText('Household')).toBeChecked();
    expect(screen.getByText('household-section embedded=true')).toBeTruthy();
    expect(mockSetOptions).toHaveBeenLastCalledWith({ title: 'Household' });
  });

  it("opens from the phone's Settings segment as the hub's own segment", async () => {
    await mount({ section: 'settings' });
    await fireEvent.press(screen.getByTestId('settings-open-household'));
    expect(mockSetParams).toHaveBeenLastCalledWith({ section: 'household', tab: undefined });
  });

  // v2.5.1 PLAYER-12: a link to it at 1280 opened a hub with no segment chosen.
  it('is in the sub-nav on tablet and desktop too, chosen for its link', async () => {
    mockLayout = 'desktop';
    await mount({ section: 'household' });
    const sections = useSubNav.getState().slots['(me)']?.sections;
    expect(sections?.options.map((o) => o.value)).toContain('household');
    expect(sections?.value).toBe('household');
    expect(screen.getByText('household-section embedded=false')).toBeTruthy();
  });

  it('leaves the wide Settings to its own Household link (the pushed page)', async () => {
    mockLayout = 'tablet';
    await mount({ section: 'settings' });
    expect(screen.queryByTestId('settings-open-household')).toBeNull();
  });
});

describe('YouHub scrolling', () => {
  it.each(['stats', 'year', 'household', 'account'])(
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
  it('publishes Stats, Year in listening, Journal and Household to the sub-nav', async () => {
    mockLayout = 'desktop';
    await mount({ section: 'year' });
    const sections = useSubNav.getState().slots['(me)']?.sections;
    expect(sections?.options.map((o) => o.label)).toEqual([
      'Stats',
      'Year in listening',
      'Journal',
      'Household',
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

describe("YouHub with a module's section (Bridge Phase 2a)", () => {
  const SIX = ['Stats', 'Year', 'Journal', 'Settings', 'Household', 'Account'];
  const FAKE: PlayerModule = {
    id: 'contributions',
    youSections: [
      {
        key: 'contribute',
        label: () => 'Contribute',
        render: ({ phone }) => <Text>{`contribute-section phone=${String(phone)}`}</Text>,
      },
      // A module can't take over one of the hub's own sections.
      { key: 'stats', label: () => 'Not stats', render: () => <Text>not-stats</Text> },
    ],
  };
  const mountWith = async (params: Record<string, string> = {}) => {
    mockParams = params;
    await render(<YouHub modules={[FAKE]} />);
  };
  const segments = () => screen.getAllByRole('radio').map((r) => r.props.accessibilityLabel);

  it('renders as before with the empty registry, asking nothing', async () => {
    await mount({ section: 'contribute' });
    expect(segments()).toEqual(SIX);
    expect(screen.getByTestId('you-hub-stats')).toBeTruthy();
    await render(<YouHub modules={[]} />);
    expect(segments()).toEqual(SIX);
    expect(mockUseActiveModules).not.toHaveBeenCalled();
  });

  it('follows Account on a phone while the module is on, a column the hub scrolls', async () => {
    mockModulesOn = { contributions: true };
    await mountWith({ section: 'contribute' });
    expect(segments()).toEqual([...SIX, 'Contribute']);
    expect(screen.getByLabelText('Contribute')).toBeChecked();
    expect(screen.getByTestId('you-hub-contribute')).toBeTruthy();
    expect(screen.getByText('contribute-section phone=true')).toBeTruthy();
    expect(screen.getByTestId('you-hub-scroll')).toBeTruthy();
    expect(mockSetOptions).toHaveBeenLastCalledWith({ title: 'Contribute' });
    expect(screen.queryByText('not-stats')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Stats'));
    expect(mockSetParams).toHaveBeenLastCalledWith({ section: undefined, tab: undefined });
  });

  it('is gone while the module is off, and a link to it opens Stats', async () => {
    await mountWith({ section: 'contribute' });
    expect(segments()).toEqual(SIX);
    expect(screen.getByTestId('you-hub-stats')).toBeTruthy();
    expect(screen.queryByText(/contribute-section/)).toBeNull();
  });

  it("follows the hub's own in the wide sub-nav", async () => {
    mockModulesOn = { contributions: true };
    mockLayout = 'desktop';
    await mountWith({ section: 'contribute' });
    const sections = useSubNav.getState().slots['(me)']?.sections;
    expect(sections?.options.map((o) => o.label)).toEqual([
      'Stats',
      'Year in listening',
      'Journal',
      'Household',
      'Contribute',
    ]);
    expect(sections?.value).toBe('contribute');
    expect(screen.getByText('contribute-section phone=false')).toBeTruthy();
  });
});

describe('YouHub Upcoming (Track U2)', () => {
  const SIX = ['Stats', 'Year', 'Journal', 'Settings', 'Household', 'Account'];
  const segments = () => screen.getAllByRole('radio').map((r) => r.props.accessibilityLabel);

  it("follows the hub's own sections while a server offers it, under the large title", async () => {
    mockUpcomingAvailable = true;
    await mount({ section: 'upcoming' });
    expect(segments()).toEqual([...SIX, 'Upcoming']);
    expect(screen.getByLabelText('Upcoming')).toBeChecked();
    expect(screen.getByText('upcoming-section embedded=true')).toBeTruthy();
    expect(screen.getByTestId('you-hub-scroll')).toBeTruthy();
    expect(mockSetOptions).toHaveBeenLastCalledWith({ title: 'Upcoming' });
  });

  it('is in the wide sub-nav too, with its own heading', async () => {
    mockUpcomingAvailable = true;
    mockLayout = 'desktop';
    await mount({ section: 'upcoming' });
    const sections = useSubNav.getState().slots['(me)']?.sections;
    expect(sections?.options.map((o) => o.label)).toEqual([
      'Stats',
      'Year in listening',
      'Journal',
      'Household',
      'Upcoming',
    ]);
    expect(screen.getByText('upcoming-section embedded=false')).toBeTruthy();
  });

  it.each([
    ['no server offers it, or the listener is a kid there', false],
    ['the servers are still loading', undefined],
  ])('is gone while %s, and a link to it opens Stats', async (_, available) => {
    mockUpcomingAvailable = available;
    await mount({ section: 'upcoming' });
    expect(segments()).toEqual(SIX);
    expect(screen.getByTestId('you-hub-stats')).toBeTruthy();
    expect(screen.queryByText(/upcoming-section/)).toBeNull();
  });
});
