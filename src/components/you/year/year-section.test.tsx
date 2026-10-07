import { fireEvent, render, screen } from '@testing-library/react-native';

import type { UserStats } from '@/api/types';

import { yearStats } from './year-fixture';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (h: unknown) => mockPush(h) } }));
let mockLayout: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
jest.mock('@/api/provider', () => ({ useCid: (id?: string) => id ?? 'a' }));
let mockConnections = [{ id: 'a', name: 'Hearthside', user: { username: 'alex' } }];
jest.mock('@/stores/session', () => ({
  useSession: (sel: (s: object) => unknown) => sel({ connections: mockConnections }),
}));
// A cover needs the server's flags and the downloads registry; the card only places it.
jest.mock('@/components/library/book-cover', () => ({
  BookCover: ({ title }: { title: string }) => {
    const { Text } = jest.requireActual('react-native');
    return <Text>{`cover: ${title}`}</Text>;
  },
}));
const mockShare = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('./use-share-card', () => ({
  useShareCard: () => ({ busy: false, coversOff: false, share: mockShare }),
}));

type Query<T> = { data?: T; isError?: boolean; refetch?: () => void };
let mockCaps: Record<string, Record<string, boolean> | undefined> = {};
let mockInfoError = false;
let mockStats: Record<string, Query<UserStats>> = {};
const mockRefetch = jest.fn();
jest.mock('@/api/hooks', () => ({
  useServerInfo: (cid: string) => ({
    data: mockCaps[cid] ? { name: 'Hearthside', capabilities: mockCaps[cid] } : undefined,
    isError: mockInfoError,
    refetch: mockRefetch,
  }),
  useCapability: (flag: string, cid: string) => {
    const caps = mockCaps[cid];
    return caps ? !!caps[flag] : undefined;
  },
  useCapabilitiesAll: () => mockCaps,
  useMyStats: (range: string) => mockStats[range] ?? {},
  useMyListening: () => ({
    data: {
      to: '2026-10-08T12:00:00Z',
      utc_offset: 0,
      days: [{ date: '2026-10-08', listened: 3600 }],
    },
  }),
  useListeningGoal: () => ({
    data: { goal: { books_per_year: 50, updated_at: '' }, year: '2026', finished: 41 },
  }),
}));

/* eslint-disable import/first */
import { YearSection } from './year-section';
/* eslint-enable import/first */

async function mount(width = 1000) {
  await render(<YearSection />);
  await fireEvent(screen.getByTestId('year-section'), 'layout', {
    nativeEvent: { layout: { width, height: 800 } },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLayout = 'desktop';
  mockConnections = [{ id: 'a', name: 'Hearthside', user: { username: 'alex' } }];
  mockCaps = { a: { user_stats: true } };
  mockInfoError = false;
  mockStats = {
    year: { data: yearStats() },
    '2025': {
      data: yearStats({
        range: '2025',
        previous: { listened: 0, sessions: 0, books: 0, finished: 0 },
      }),
    },
  };
});

describe('YearSection', () => {
  it('puts the story on stage beside its column on a desktop', async () => {
    await mount();
    expect(screen.getByText('Your 2026, as a story')).toBeTruthy();
    expect(screen.getByLabelText(/^Card 1 of 8\. AudioSilo · Hearthside\./)).toBeTruthy();
    expect(screen.getByText(/Nothing leaves the server unless you share a card\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Card 2: 41 books' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Share this card' })).toBeTruthy();
  });

  it('moves through the cards with the tap zones and the thumbnails', async () => {
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Next card' }));
    expect(screen.getByLabelText(/^Card 2 of 8\. Books finished\./)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Previous card' }));
    expect(screen.getByLabelText(/^Card 1 of 8\./)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Card 3: Book of the year' }));
    expect(screen.getByLabelText(/^Card 3 of 8\. Your book of the year\./)).toBeTruthy();
    expect(screen.getByText('cover: The Way of Kings')).toBeTruthy();
  });

  it('shares the card on stage as an image', async () => {
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Next card' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Share this card' }));
    expect(mockShare).toHaveBeenCalledWith(expect.anything(), {
      fileName: 'audiosilo-2026-02-books.png',
      title: 'My 2026 in listening',
    });
  });

  it('offers an earlier year once it has a story too', async () => {
    await mount();
    const earlier = screen.getByRole('checkbox', { name: '2025' });
    await fireEvent.press(earlier);
    expect(screen.getByText('Your 2025, as a story')).toBeTruthy();
  });

  it('has no year picker while only this year has a story', async () => {
    mockStats['2025'] = {
      data: yearStats({
        range: '2025',
        totals: { listened: 0, sessions: 0, books: 0, finished: 0 },
        previous: { listened: 0, sessions: 0, books: 0, finished: 0 },
      }),
    };
    await mount();
    expect(screen.queryByRole('checkbox', { name: '2026' })).toBeNull();
  });

  it('offers a server picker with more than one server that keeps stats', async () => {
    mockConnections = [
      { id: 'a', name: 'Hearthside', user: { username: 'alex' } },
      { id: 'b', name: "Maya's Shelf", user: { username: 'alex' } },
      { id: 'c', name: 'Old box', user: { username: 'alex' } },
    ];
    mockCaps = { a: { user_stats: true }, b: { user_stats: true }, c: { user_stats: false } };
    await mount();
    expect(screen.getByRole('checkbox', { name: "Maya's Shelf" })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Old box' })).toBeNull();
  });

  it('opens the full-screen story from the phone intro', async () => {
    mockLayout = 'phone';
    await mount(390);
    expect(screen.getByText('Your 2026 in listening')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Play the story' }));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/year', params: {} });
    await fireEvent.press(screen.getByRole('button', { name: 'Card 4: Voice of the year' }));
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/year', params: { card: '3' } });
  });

  it('says calmly when the server keeps no stats', async () => {
    mockCaps = { a: { user_stats: false } };
    await mount();
    expect(screen.getByText('No listening stats on this server yet')).toBeTruthy();
  });

  it('shows a calm empty state for a year with too little listening', async () => {
    mockStats.year = {
      data: yearStats({ totals: { listened: 600, sessions: 1, books: 1, finished: 0 } }),
    };
    await mount();
    expect(screen.getByText('Not much of a story yet')).toBeTruthy();
    expect(screen.queryByText('Share this card')).toBeNull();
  });

  it('offers a retry when the stats fail', async () => {
    const refetch = jest.fn();
    mockStats.year = { isError: true, refetch };
    await mount();
    expect(screen.getByText("Couldn't load your year")).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('shows the stage shapes while loading', async () => {
    mockStats.year = {};
    await mount();
    expect(screen.getByTestId('year-stage-skeleton')).toBeTruthy();
  });
});
