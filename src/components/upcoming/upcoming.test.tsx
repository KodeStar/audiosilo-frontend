import { fireEvent, render, screen } from '@testing-library/react-native';

import type { SourcedUpcomingItem, UpcomingServerStatus } from '@/lib/upcoming';

const mockPush = jest.fn();
const mockOpenSeries = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (h: unknown) => mockPush(h) } }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/lib/open', () => ({
  useOpen: () => ({ openSeries: (...a: unknown[]) => mockOpenSeries(...a) }),
}));
let mockLabels: Record<string, string> = {};
jest.mock('@/components/library/cover-tile', () => ({
  useServerFlag: () => (cid: string) => mockLabels[cid],
}));
let mockUpcoming: {
  items: SourcedUpcomingItem[];
  available: boolean | undefined;
  isLoading: boolean;
  statuses: UpcomingServerStatus[];
  failed: string[];
  retry: () => void;
};
const mockRetry = jest.fn();
// Each connection's `upcoming_covers` flag (Track U3), undefined while not known.
let mockCovers: Record<string, boolean | undefined> = {};
let mockCalendarRows: { id: string; demo: boolean }[] = [];
jest.mock('@/api/hooks', () => ({
  useUpcomingAll: () => mockUpcoming,
  useCapability: (flag: string, cid: string) =>
    flag === 'upcoming_covers' ? mockCovers[cid] : undefined,
  useUpcomingCalendarConnections: () => mockCalendarRows,
}));
// Each connection's client builds its cover URLs (`upcomingCoverUrl`).
const mockClient = (cid: string) => ({
  upcomingCoverUrl: (work: string, o?: { size?: number }) =>
    `https://${cid}/api/v1/me/upcoming/cover?work=${work}&size=${o?.size}&token=t`,
  authHeaders: () => ({ Authorization: 'Bearer t' }),
});
jest.mock('@/api/provider', () => ({
  useOptionalApi: (cid?: string) => (cid ? mockClient(cid) : null),
}));
// A host stand-in for expo-image, so a test can read the source and fire its error.
jest.mock('expo-image', () => {
  const { View } = jest.requireActual('react-native');
  return { Image: (props: object) => <View {...props} /> };
});
// The calendar card has its own tests (upcoming-calendar.test.tsx).
jest.mock('./upcoming-calendar', () => ({
  UpcomingCalendarCard: () => {
    const { Text } = jest.requireActual('react-native');
    return mockCalendarRows.length ? <Text testID="upcoming-calendar">card</Text> : null;
  },
}));

/* eslint-disable import/first */
import { formatReleaseDate } from '@/lib/format';
import { settleFlashList } from '@/testing/flash-list';
import { sourcedUpcoming } from '@/testing/upcoming-fixtures';

import { upcomingDateLabel } from './upcoming-parts';
import { UPCOMING_RAIL_LIMIT, UpcomingRail } from './upcoming-rail';
import { UpcomingContent } from './upcoming-screen';
/* eslint-enable import/first */

const NOW = new Date('2026-10-30T12:00:00Z');
const ok = (connectionId = 'a'): UpcomingServerStatus => ({
  connectionId,
  connectionName: connectionId,
  status: 'ok',
});

const preorder = sourcedUpcoming({
  id: 'p',
  kind: 'preorder',
  release_date: '2026-11-12',
  first_seen_at: '2026-10-29T04:00:00Z',
  work: { id: 'p', title: 'Beware Six', authors: [], web_url: 'https://meta/p' },
  series: { id: 'boc', name: 'Beware of Chicken', position: '6' },
  local: { library_id: 3, series: 'Beware Of Chicken' },
});
const released = sourcedUpcoming(
  {
    id: 'r',
    kind: 'released',
    release_date: '2026-10',
    work: { id: 'r', title: 'Starship Four', authors: [], web_url: 'https://meta/r' },
    series: { id: 'ss', name: '1-800-Starship', position: '4' },
  },
  'b',
);
const missing = sourcedUpcoming({
  id: 'm',
  kind: 'missing',
  work: { id: 'm', title: 'The Gap', authors: [], web_url: 'https://meta/m' },
  series: { id: 'gap', name: 'Gapped', position: '2' },
});

// Nothing in, nothing loading, nobody failed: each case says what differs.
const idle = {
  items: [] as SourcedUpcomingItem[],
  available: undefined as boolean | undefined,
  isLoading: false,
  statuses: [] as UpcomingServerStatus[],
  failed: [] as string[],
  retry: mockRetry,
};

beforeAll(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['setTimeout'] });
});
afterAll(() => jest.useRealTimers());

beforeEach(() => {
  jest.clearAllMocks();
  mockLabels = {};
  mockCovers = {};
  mockCalendarRows = [];
  mockUpcoming = { ...idle, available: true, statuses: [ok()] };
});

describe('upcomingDateLabel', () => {
  const t = ((key: string, o: { date: string }) => `${key}:${o.date}`) as never;
  it('says each kind its own way, and nothing without a date', () => {
    expect(upcomingDateLabel({ kind: 'preorder', release_date: '2027' }, t)).toBe(
      'upcoming.out:2027',
    );
    expect(upcomingDateLabel({ kind: 'released', release_date: '2026-10' }, t)).toBe(
      `upcoming.released:${formatReleaseDate('2026-10')}`,
    );
    expect(upcomingDateLabel({ kind: 'missing', release_date: '2014' }, t)).toBe(
      'upcoming.firstReleased:2014',
    );
    expect(upcomingDateLabel({ kind: 'missing' }, t)).toBe('');
  });
});

describe('UpcomingRail', () => {
  const mount = async () => {
    await render(<UpcomingRail />);
    await settleFlashList();
  };

  it('renders nothing while there is nothing to show', async () => {
    await mount();
    expect(screen.queryByText('Coming up in your series')).toBeNull();
    mockUpcoming = { ...idle, isLoading: true };
    await mount();
    expect(screen.queryByText('Coming up in your series')).toBeNull();
    // No server offers it (or a kid): nothing either.
    mockUpcoming = { ...idle, available: false };
    await mount();
    expect(screen.queryByText('Coming up in your series')).toBeNull();
  });

  it('shows the items with their dates, the New badge, and See all', async () => {
    mockUpcoming.items = [preorder, released, missing];
    await mount();
    expect(screen.getByText('Coming up in your series')).toBeTruthy();
    expect(screen.getAllByTestId('upcoming-tile')).toHaveLength(3);
    expect(screen.getByText(`Out ${formatReleaseDate('2026-11-12')}`)).toBeTruthy();
    expect(screen.getByText('Beware of Chicken, book 6')).toBeTruthy();
    // Only the preorder was first listed in the last week.
    expect(screen.getAllByTestId('upcoming-new')).toHaveLength(1);
    await fireEvent.press(screen.getByLabelText('See all'));
    expect(mockPush).toHaveBeenCalledWith('/upcoming');
  });

  it('opens the series page by its local name, pinned to the work', async () => {
    mockUpcoming.items = [preorder];
    await mount();
    await fireEvent.press(screen.getByTestId('upcoming-tile'));
    expect(mockOpenSeries).toHaveBeenCalledWith('a', 3, { name: 'Beware Of Chicken', work: 'p' });
  });

  it(`shows at most ${UPCOMING_RAIL_LIMIT}`, async () => {
    mockUpcoming.items = Array.from({ length: 20 }, (_, i) => sourcedUpcoming({ id: `w${i}` }));
    await mount();
    expect(screen.getAllByTestId('upcoming-tile').length).toBeLessThanOrEqual(UPCOMING_RAIL_LIMIT);
  });
});

describe('UpcomingContent', () => {
  it('lists the three sections in order, hiding an empty one', async () => {
    mockUpcoming.items = [preorder, missing];
    await render(<UpcomingContent />);
    expect(screen.getByText('Upcoming')).toBeTruthy();
    expect(screen.getByTestId('upcoming-section-preorder')).toBeTruthy();
    expect(screen.queryByTestId('upcoming-section-released')).toBeNull();
    expect(screen.getByTestId('upcoming-section-missing')).toBeTruthy();
    const headings = screen.getAllByRole('header').map((h) => h.props.children);
    expect(headings).toEqual(['Upcoming', 'Coming soon', 'Missing from your series']);
    // A missing volume without a date has no date line.
    expect(screen.getByText('Gapped, book 2')).toBeTruthy();
    expect(screen.getAllByTestId('upcoming-row')).toHaveLength(2);
  });

  it('names the server when several are connected', async () => {
    mockUpcoming.items = [preorder, released];
    mockLabels = { b: 'Maya' };
    await render(<UpcomingContent />);
    expect(screen.getByTestId('upcoming-section-released')).toBeTruthy();
    expect(screen.getByText(`Released ${formatReleaseDate('2026-10')} · From Maya`)).toBeTruthy();
  });

  it('leaves out the heading under the hub title (embedded)', async () => {
    mockUpcoming.items = [missing];
    await render(<UpcomingContent embedded />);
    expect(screen.queryByText('Upcoming')).toBeNull();
  });

  it('stands rows in while it loads', async () => {
    mockUpcoming = { ...idle };
    await render(<UpcomingContent />);
    expect(screen.getByTestId('upcoming-skeleton', { includeHiddenElements: true })).toBeTruthy();
    mockUpcoming = { ...idle, available: true, isLoading: true };
    await render(<UpcomingContent />);
    expect(screen.getByTestId('upcoming-skeleton', { includeHiddenElements: true })).toBeTruthy();
  });

  it("says the server's first check is still running", async () => {
    mockUpcoming.statuses = [{ ...ok(), status: 'pending' }];
    await render(<UpcomingContent />);
    expect(screen.getByText('Checking for releases')).toBeTruthy();
    expect(
      screen.getByText(
        'Your server is checking for releases; this list fills after its first check.',
      ),
    ).toBeTruthy();
  });

  it('says when nothing is coming up', async () => {
    await render(<UpcomingContent />);
    expect(screen.getByText('Nothing coming up')).toBeTruthy();
  });

  it('says it is not available where no server offers it', async () => {
    mockUpcoming = { ...idle, available: false };
    await render(<UpcomingContent />);
    expect(screen.getByText('No upcoming releases here')).toBeTruthy();
    expect(screen.queryByTestId('upcoming-row')).toBeNull();
  });

  it('notes a stale server and one still on its first check over the list', async () => {
    mockUpcoming.items = [missing];
    mockUpcoming.statuses = [
      { connectionId: 'a', connectionName: 'Home', status: 'stale' },
      { connectionId: 'b', connectionName: 'Maya', status: 'pending' },
    ];
    await render(<UpcomingContent />);
    expect(screen.getByTestId('upcoming-stale').props.children).toMatch(/^Home hasn't checked/);
    expect(screen.getByTestId('upcoming-pending-some').props.children).toMatch(/^Maya is still/);
  });

  it('names several servers as a list, with the verb counted', async () => {
    mockUpcoming.items = [missing];
    mockUpcoming.failed = ['Home', 'Maya'];
    mockUpcoming.statuses = [
      { connectionId: 'a', connectionName: 'Home', status: 'stale' },
      { connectionId: 'b', connectionName: 'Maya', status: 'stale' },
      { connectionId: 'c', connectionName: 'Sam', status: 'pending' },
      { connectionId: 'd', connectionName: 'Jo', status: 'pending' },
      { connectionId: 'e', connectionName: 'Al', status: 'pending' },
    ];
    await render(<UpcomingContent />);
    expect(screen.getByTestId('upcoming-stale').props.children).toBe(
      "Home and Maya haven't checked for releases in over two days, so this list may be out of date.",
    );
    expect(screen.getByTestId('upcoming-pending-some').props.children).toBe(
      'Sam, Jo and Al are still running their first check for releases.',
    );
    expect(
      screen.getByText("Home and Maya didn't answer, so this list may be missing some releases."),
    ).toBeTruthy();
  });

  // A cold link whose only non-kid server's flags could not be read: the hook says
  // unavailable with that server failed, and the page offers a Retry, not "not available".
  it('offers a Retry when the only server could not be read at all', async () => {
    mockUpcoming = { ...idle, available: false, failed: ['Home'] };
    await render(<UpcomingContent />);
    expect(screen.getByText("Couldn't load upcoming releases")).toBeTruthy();
    expect(
      screen.getByText("Home didn't answer. Nothing is lost: try again in a moment."),
    ).toBeTruthy();
    expect(screen.queryByText('No upcoming releases here')).toBeNull();
    expect(screen.queryByTestId('upcoming-skeleton', { includeHiddenElements: true })).toBeNull();
  });

  it('says no server answered, with a Retry, never that nothing is coming up', async () => {
    mockUpcoming = { ...idle, available: true, failed: ['Home'] };
    await render(<UpcomingContent />);
    expect(screen.getByText("Couldn't load upcoming releases")).toBeTruthy();
    expect(screen.queryByText('Nothing coming up')).toBeNull();
    await fireEvent.press(screen.getByText('Retry'));
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it('notes a server that did not answer beside the ones that did', async () => {
    mockUpcoming.items = [missing];
    mockUpcoming.failed = ['Maya'];
    await render(<UpcomingContent />);
    expect(
      screen.getByText("Maya didn't answer, so this list may be missing some releases."),
    ).toBeTruthy();
    expect(screen.getAllByTestId('upcoming-row')).toHaveLength(1);
  });

  it('keeps the notes over "nothing coming up"', async () => {
    mockUpcoming.statuses = [
      { connectionId: 'a', connectionName: 'Home', status: 'stale' },
      { connectionId: 'b', connectionName: 'Maya', status: 'pending' },
    ];
    await render(<UpcomingContent />);
    expect(screen.getByText('Nothing coming up')).toBeTruthy();
    expect(screen.getByTestId('upcoming-stale')).toBeTruthy();
    expect(screen.getByTestId('upcoming-pending-some')).toBeTruthy();
  });
});

describe('the cover swap (Track U3)', () => {
  const covered = sourcedUpcoming({
    id: 'c1',
    kind: 'preorder',
    release_date: '2026-11-12',
    work: {
      id: 'c1',
      title: 'Covered',
      authors: [],
      cover_url: 'https://meta.example/c1.jpg',
      web_url: 'https://meta/c1',
    },
  });
  // Hidden from assistive tech (the ghost under it carries the name): look past that.
  const image = () => screen.queryByTestId('upcoming-cover-image', { includeHiddenElements: true });

  it("draws the work's cover from its own server over the ghost when the server serves it", async () => {
    mockCovers = { a: true };
    mockUpcoming.items = [covered];
    await render(<UpcomingContent />);
    const src = image()!.props.source;
    expect(src.uri).toMatch(
      /^https:\/\/a\/api\/v1\/me\/upcoming\/cover\?work=c1&size=\d+&token=t$/,
    );
    expect(src.headers).toEqual({ Authorization: 'Bearer t' });
    // The ghost stays underneath (it shows while the image loads).
    expect(screen.getByTestId('ghost-cover-mark', { includeHiddenElements: true })).toBeTruthy();
  });

  it('asks the server the item came from, not another', async () => {
    mockCovers = { a: false, b: true };
    mockUpcoming.items = [{ ...covered, connectionId: 'b', connectionName: 'b' }];
    await render(<UpcomingContent />);
    expect(image()!.props.source.uri).toMatch(/^https:\/\/b\//);
  });

  it('keeps the ghost without the flag, while it is unknown, or without a cover_url', async () => {
    mockUpcoming.items = [covered];
    mockCovers = { a: false };
    await render(<UpcomingContent />);
    expect(image()).toBeNull();
    mockCovers = {};
    await render(<UpcomingContent />);
    expect(image()).toBeNull();
    mockCovers = { a: true };
    mockUpcoming.items = [missing];
    await render(<UpcomingContent />);
    expect(image()).toBeNull();
    expect(screen.getByTestId('ghost-cover-mark', { includeHiddenElements: true })).toBeTruthy();
  });

  it('falls back to the ghost when the cover fails to load', async () => {
    mockCovers = { a: true };
    mockUpcoming.items = [covered];
    await render(<UpcomingContent />);
    await fireEvent(image()!, 'error');
    expect(image()).toBeNull();
    expect(screen.getByTestId('ghost-cover-mark', { includeHiddenElements: true })).toBeTruthy();
  });

  it('swaps on the rail too', async () => {
    mockCovers = { a: true };
    mockUpcoming.items = [covered];
    await render(<UpcomingRail />);
    await settleFlashList();
    expect(image()!.props.source.uri).toContain('/me/upcoming/cover?work=c1');
  });
});

describe('the calendar card on the page', () => {
  it('shows under the list where a server offers it', async () => {
    mockCalendarRows = [{ id: 'a', demo: false }];
    mockUpcoming.items = [missing];
    await render(<UpcomingContent />);
    expect(screen.getByTestId('upcoming-calendar')).toBeTruthy();
  });

  it('is not there where Upcoming is not available (a kid, no server)', async () => {
    mockCalendarRows = [{ id: 'a', demo: false }];
    mockUpcoming = { ...idle, available: false };
    await render(<UpcomingContent />);
    expect(screen.queryByTestId('upcoming-calendar')).toBeNull();
  });
});
