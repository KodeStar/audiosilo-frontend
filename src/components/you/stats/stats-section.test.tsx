import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import type { ListeningGoalStatus, MyListening, UserStats } from '@/api/types';
import { addDays } from '@/components/home/listening';
import { mountWithPortal } from '@/testing/render-overlay';
import { nativeTarget } from '@/testing/touch-target';

jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('expo-router', () => ({ router: { navigate: jest.fn(), push: jest.fn() } }));
let mockLayout: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
const mockOpen = {
  openAuthor: jest.fn(),
  openNarrator: jest.fn(),
  openSeries: jest.fn(),
  openBook: jest.fn(),
  openJournal: jest.fn(),
  openYou: jest.fn(),
};
jest.mock('@/lib/open', () => ({ useOpen: () => mockOpen }));

let mockConnections = [{ id: 'a', name: 'Hearthside' }];
jest.mock('@/api/provider', () => ({
  useApis: () => mockConnections.map((connection) => ({ connection, client: {} })),
  useCid: () => 'a',
}));

const TODAY = '2026-10-08';
type Q<T> = { data?: T; isError?: boolean; isLoading?: boolean; refetch: jest.Mock };
const q = <T,>(data?: T, extra: Partial<Q<T>> = {}): Q<T> => ({
  data,
  isError: false,
  isLoading: false,
  refetch: jest.fn(async () => undefined),
  ...extra,
});
let mockCaps: Record<string, { user_stats: boolean } | undefined> = {};
let mockListening: Q<MyListening>;
let mockStats: Q<UserStats>;
let mockGoal: Q<ListeningGoalStatus>;
const mockSetGoal = { mutate: jest.fn(), isPending: false, variables: undefined as unknown };
const mockClearGoal = { mutate: jest.fn(), isPending: false };
const mockCalls: string[] = [];
jest.mock('@/api/hooks', () => ({
  CapabilityError: class extends Error {},
  useCapabilitiesAll: () => mockCaps,
  useCapability: (flag: string, cid: string) => {
    const c = mockCaps[cid];
    return c ? c.user_stats : undefined;
  },
  useLibrariesAll: () => ({
    groups: [{ connectionId: 'a', libraries: [{ id: 7 }] }],
  }),
  useMyListening: (range: string, cid: string) => {
    mockCalls.push(`listening:${range}:${cid}`);
    return mockListening;
  },
  useMyStats: (range: string, cid: string) => {
    mockCalls.push(`stats:${range}:${cid}`);
    return mockStats;
  },
  useListeningGoal: () => mockGoal,
  useSetListeningGoal: () => mockSetGoal,
  useClearListeningGoal: () => mockClearGoal,
}));

/* eslint-disable import/first */
import { StatsSection } from './stats-section';
/* eslint-enable import/first */

/** A year of listening: an hour a day, more on Saturdays, nothing on Mondays. */
function year(n = 366) {
  return Array.from({ length: n }, (_, i) => {
    const date = addDays(TODAY, i - n + 1);
    const wd = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
    return { date, listened: wd === 0 ? 0 : wd === 5 ? 5760 : 3600 };
  });
}

function hourWeekday(): number[][] {
  return Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, (_, h) => (h === 22 ? 9000 : h === 7 ? 7200 : h === 13 ? 600 : 0)),
  );
}

function fixtures() {
  const days = year();
  const period = { from: '', to: `${TODAY}T12:00:00Z`, timezone: 'UTC', utc_offset: 0 };
  mockListening = q({ ...period, range: '1y', days });
  const yearDays = days.filter((d) => d.date >= '2026-01-01');
  mockStats = q({
    ...period,
    range: '2026',
    totals: { listened: 400 * 3600, sessions: 300, books: 14, finished: 3 },
    previous: { listened: 0, sessions: 0, books: 0, finished: 0 },
    estimated: 0,
    days: yearDays,
    hour_weekday: hourWeekday(),
    top_books: [
      {
        library_id: 2,
        path: 'sand/wok',
        title: 'The Way of Kings',
        author: 'Brandon Sanderson',
        listened: 3600,
      },
    ],
    top_authors: [
      { name: 'Brandon Sanderson', listened: 72 * 3600, books: 4 },
      { name: 'Martha Wells', listened: 19 * 3600, books: 3 },
    ],
    top_narrators: [{ name: 'Michael Kramer', listened: 61 * 3600, books: 4 }],
    top_series: [{ name: 'The Stormlight Archive', listened: 64 * 3600, books: 3 }],
    finished_books: [
      {
        library_id: 2,
        path: 'b/2',
        title: 'Second',
        author: 'Ann Lee',
        finished_at: '2026-09-01T10:00:00Z',
      },
      {
        library_id: 2,
        path: 'b/1',
        title: 'First',
        author: 'Ann Lee',
        finished_at: '2026-03-01T10:00:00Z',
      },
    ],
    playback: [],
    clients: [],
  });
  mockGoal = q({ goal: { books_per_year: 24, updated_at: '' }, year: '2026', finished: 3 });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCalls.length = 0;
  mockLayout = 'desktop';
  mockConnections = [{ id: 'a', name: 'Hearthside' }];
  mockCaps = { a: { user_stats: true } };
  mockSetGoal.isPending = false;
  mockSetGoal.variables = undefined;
  mockClearGoal.isPending = false;
  fixtures();
});

const mount = () => mountWithPortal(<StatsSection />);

describe('StatsSection states', () => {
  it('explains calmly when the server keeps no stats', async () => {
    mockCaps = { a: { user_stats: false } };
    await mount();
    expect(screen.getByText('No listening stats here yet')).toBeTruthy();
    expect(screen.getByText(/Hearthside doesn't keep listening stats yet/)).toBeTruthy();
  });

  it('shows placeholders while the stats load', async () => {
    mockStats = q<UserStats>(undefined, { isLoading: true });
    await mount();
    expect(screen.getByTestId('stats-skeleton')).toBeTruthy();
  });

  it('offers a retry when the stats fail', async () => {
    mockStats = q<UserStats>(undefined, { isError: true });
    await mount();
    expect(screen.getByText("Your listening didn't load")).toBeTruthy();
    await fireEvent.press(screen.getByText('Retry'));
    expect(mockStats.refetch).toHaveBeenCalled();
    expect(mockListening.refetch).toHaveBeenCalled();
  });

  it('says so when there is no listening yet', async () => {
    mockListening.data!.days = mockListening.data!.days.map((d) => ({ ...d, listened: 0 }));
    mockStats.data!.totals.listened = 0;
    await mount();
    expect(screen.getByText('No listening yet')).toBeTruthy();
    expect(screen.getByText('0m this week')).toBeTruthy();
    // No story to open yet.
    expect(screen.queryByText('Open your 2026 story')).toBeNull();
  });
});

describe('StatsSection content', () => {
  it('heads the page with this week on the default server, in server time', async () => {
    await mount();
    // Tue-Sun of this week plus last Fri-Sun... the last seven days: 5 hours + a Saturday.
    expect(screen.getByText('Your listening · Hearthside')).toBeTruthy();
    expect(screen.getByText('6h 36m this week')).toBeTruthy();
    expect(mockCalls).toContain('listening:1y:a');
    expect(mockCalls).toContain('stats:year:a');
  });

  it('reads each tile as label, value and context', async () => {
    await mount();
    expect(screen.getByLabelText('This week, 6h 36m, The same as last week')).toBeTruthy();
    // Monday had none, so the streak runs Tuesday to Thursday.
    expect(screen.getByLabelText(/^Streak, 3 days, Longest this year: 6 days$/)).toBeTruthy();
    expect(screen.getByLabelText(/^Daily average, .*, Across 14 books this year$/)).toBeTruthy();
    expect(screen.getByLabelText('Goal: 3 of 24 books finished this year, 13%')).toBeTruthy();
  });

  it('opens the Year section from the header (tablet and desktop) and the banner', async () => {
    await mount();
    await fireEvent.press(screen.getByText('Open your 2026 story'));
    expect(mockOpen.openYou).toHaveBeenLastCalledWith('year');
    await fireEvent.press(screen.getByLabelText(/^Your 2026 in listening\./));
    expect(mockOpen.openYou).toHaveBeenCalledTimes(2);
  });

  it('leaves the header button off a phone, and the page name off its eyebrow', async () => {
    mockLayout = 'phone';
    await mount();
    // The hub's large title says "Your listening" there.
    expect(screen.getByText('Hearthside')).toBeTruthy();
    expect(screen.queryByText('Your listening · Hearthside')).toBeNull();
    expect(screen.queryByText('Open your 2026 story')).toBeNull();
  });

  it("opens a rank row's page in the library its books are in", async () => {
    await mount();
    await fireEvent.press(screen.getByLabelText('1. Brandon Sanderson, 72h, 4 books'));
    expect(mockOpen.openAuthor).toHaveBeenCalledWith('a', 2, 'Brandon Sanderson');
    await fireEvent.press(screen.getByLabelText('1. The Stormlight Archive, 64h, 3 books'));
    expect(mockOpen.openSeries).toHaveBeenCalledWith('a', 2, { name: 'The Stormlight Archive' });
    await fireEvent.press(screen.getByLabelText('1. Michael Kramer, 61h, 4 books'));
    expect(mockOpen.openNarrator).toHaveBeenCalledWith('a', 2, 'Michael Kramer');
  });

  it('falls back to the server’s first library when the stats name none', async () => {
    mockStats.data!.top_books = [];
    mockStats.data!.finished_books = [];
    await mount();
    await fireEvent.press(screen.getByLabelText('1. Michael Kramer, 61h, 4 books'));
    expect(mockOpen.openNarrator).toHaveBeenCalledWith('a', 7, 'Michael Kramer');
  });

  it('shelves the finished books, each opening its book, and links the Journal', async () => {
    await mount();
    expect(screen.getByText('3 books')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText(/^First by Ann Lee, finished/));
    expect(mockOpen.openBook).toHaveBeenCalledWith('a', 2, 'b/1');
    await fireEvent.press(screen.getByText('See them in your Journal'));
    expect(mockOpen.openJournal).toHaveBeenCalled();
  });

  it('summarises each chart in words', async () => {
    await mount();
    expect(
      screen.getByLabelText(
        /^Listening calendar for the last 12 months: you listened on \d+ days$/,
      ),
    ).toBeTruthy();
    // jest runs in en-US: the reader's clock is 12-hour.
    expect(
      screen.getByLabelText(/^Listening by hour of day this year\. Busiest hour 10:00 PM\./),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(/^Hours listened per week, last 12 weeks: 11 weeks ago: /),
    ).toBeTruthy();
    expect(screen.getByText('Peaks at 10:00 PM-11:00 PM and 7:00 AM-8:00 AM')).toBeTruthy();
  });
});

describe('StatsSection goal', () => {
  it('raises and lowers the goal through the mutation', async () => {
    await mount();
    await fireEvent.press(screen.getByLabelText('Raise the yearly goal'));
    expect(mockSetGoal.mutate).toHaveBeenLastCalledWith(26, expect.anything());
    await fireEvent.press(screen.getByLabelText('Lower the yearly goal'));
    expect(mockSetGoal.mutate).toHaveBeenLastCalledWith(22, expect.anything());
    await fireEvent.press(screen.getByLabelText('Clear the yearly goal'));
    expect(mockClearGoal.mutate).toHaveBeenCalled();
  });

  it('steps on from the value still being saved', async () => {
    mockSetGoal.isPending = true;
    mockSetGoal.variables = 30;
    await mount();
    expect(screen.getByLabelText('Goal: 3 of 30 books finished this year, 10%')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Raise the yearly goal'));
    expect(mockSetGoal.mutate).toHaveBeenLastCalledWith(32, expect.anything());
  });

  it('offers a first goal from the pace when there is none', async () => {
    mockGoal = q({ goal: null, year: '2026', finished: 3 });
    await mount();
    expect(screen.getByText('3 books finished this year, no goal set')).toBeTruthy();
    await fireEvent.press(screen.getByText('Set a yearly goal'));
    expect(mockSetGoal.mutate).toHaveBeenCalledWith(12, expect.anything());
  });

  it('gives the goal buttons a 44 pt frame on native', async () => {
    await mount();
    const raise = screen.getByLabelText('Raise the yearly goal');
    expect(String(raise.props.className)).toContain('min-h-[44px]');
    expect(String(raise.props.className)).toContain('min-w-[44px]');
    expect(nativeTarget(raise).height).toBeGreaterThanOrEqual(44);
  });
});

describe('StatsSection charts', () => {
  it('shows the tapped day of the calendar (native)', async () => {
    await mount();
    expect(screen.queryByTestId('calendar-tip')).toBeNull();
    // The jest window is 750 wide: 11 pt cells (the minimum) with a 3 gap, scrolling.
    // Column 52, row 3 is today.
    const cell = 11 + 3;
    await fireEvent.press(screen.getByTestId('calendar-pointer'), {
      nativeEvent: { locationX: 52 * cell + 2, locationY: 3 * cell + 2 },
    });
    expect(screen.getByText('1h')).toBeTruthy();
    expect(screen.getByTestId('calendar-tip')).toBeTruthy();
  });

  it('shows the hovered week on the web', async () => {
    const os = Platform.OS;
    Platform.OS = 'web';
    try {
      await mount();
      const layer = screen.getByTestId('bars-pointer', { includeHiddenElements: true });
      // One chart a row in the 750 wide jest window: the bars are 676 wide.
      const rect = { left: 0, top: 0, width: 676, height: 148 };
      await act(async () => {
        layer.props.onPointerMove({
          nativeEvent: { clientX: 670, clientY: 50, pointerType: 'mouse' },
          currentTarget: { getBoundingClientRect: () => rect },
        });
      });
      expect(screen.getByTestId('bars-tip', { includeHiddenElements: true })).toBeTruthy();
      expect(screen.getByText('6h 36m · this week', { includeHiddenElements: true })).toBeTruthy();
      await act(async () => {
        layer.props.onPointerLeave({ nativeEvent: { pointerType: 'mouse' } });
      });
      expect(screen.queryByTestId('bars-tip', { includeHiddenElements: true })).toBeNull();
    } finally {
      Platform.OS = os;
    }
  });

  it('reads the tapped hour in the middle of the clock', async () => {
    await mount();
    expect(screen.getByText('your busiest hour')).toBeTruthy();
    // The clock is 280 wide on desktop: a tap just right of the top is hour 0... pick 07.
    const size = 280;
    const a = ((7.5 / 24) * 360 - 90) * (Math.PI / 180);
    await fireEvent.press(screen.getByTestId('clock-pointer'), {
      nativeEvent: {
        locationX: size / 2 + Math.cos(a) * size * 0.35,
        locationY: size / 2 + Math.sin(a) * size * 0.35,
      },
    });
    expect(screen.getByText('14h this year')).toBeTruthy();
    expect(screen.getByText('7:00 AM')).toBeTruthy();
  });
});

describe('StatsSection servers', () => {
  it('picks between servers that keep stats', async () => {
    mockConnections = [
      { id: 'a', name: 'Hearthside' },
      { id: 'b', name: "Maya's Shelf" },
      { id: 'c', name: 'Old box' },
    ];
    mockCaps = { a: { user_stats: true }, b: { user_stats: true }, c: { user_stats: false } };
    await mount();
    expect(screen.queryByText('Old box')).toBeNull();
    await fireEvent.press(screen.getByText("Maya's Shelf"));
    expect(mockCalls).toContain('stats:year:b');
    expect(screen.getByText("Your listening · Maya's Shelf")).toBeTruthy();
  });

  it('shows no picker with one server keeping stats', async () => {
    mockConnections = [
      { id: 'a', name: 'Hearthside' },
      { id: 'c', name: 'Old box' },
    ];
    mockCaps = { a: { user_stats: true }, c: { user_stats: false } };
    await render(<StatsSection />);
    expect(screen.queryByLabelText('Server')).toBeNull();
  });
});
