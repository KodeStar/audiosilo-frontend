import { fireEvent, render, screen } from '@testing-library/react-native';

import type { HouseListening, HouseListeningRow, HouseholdSettings } from '@/api/types';

let mockFocused = true;
jest.mock('expo-router', () => ({ useIsFocused: () => mockFocused }));
let mockLayout: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
const mockOpenBook = jest.fn();
const mockOpenHousehold = jest.fn();
jest.mock('@/lib/open', () => ({
  useOpen: () => ({ openBook: (...a: unknown[]) => mockOpenBook(...a) }),
  openHousehold: (...a: unknown[]) => mockOpenHousehold(...a),
}));
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));

/** Per connection: the caller's setting and the house's answer (undefined = loading,
 * an error, or a server without `household`: the hooks hand back no data). */
const mockSettings: Record<string, HouseholdSettings | undefined> = {};
const mockHouse: Record<string, HouseListening | undefined> = {};
const mockListening = jest.fn();
jest.mock('@/api/hooks', () => ({
  useHousehold: (cid: string) => ({ data: mockSettings[cid] }),
  useHouseListening: (cid: string, opts: { enabled?: boolean }) => {
    mockListening(cid, opts);
    return { data: mockHouse[cid] };
  },
}));

/* eslint-disable import/first */
import type { Connection } from '@/stores/session';

import { HouseRow } from './house-row';
/* eslint-enable import/first */

const conn = (id: string, name: string) => ({ id, name }) as Connection;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function row(over: Partial<HouseListeningRow> = {}): HouseListeningRow {
  return {
    user_id: 3,
    username: 'sam',
    library_id: 1,
    path: 'Will Wight/Unsouled',
    title: 'Unsouled',
    author: 'Will Wight',
    state: 'playing',
    position: 100,
    duration: 1000,
    chapter: null,
    chapter_index: 3,
    updated_at: minutesAgo(0),
    ...over,
  };
}

function share(cid: string, listening: HouseListeningRow[]) {
  mockSettings[cid] = { share_listening: true };
  mockHouse[cid] = { sharing: true, listening };
}

beforeEach(() => {
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  for (const k of Object.keys(mockHouse)) delete mockHouse[k];
  mockListening.mockReset();
  mockOpenBook.mockReset();
  mockOpenHousehold.mockReset();
  mockFocused = true;
  mockLayout = 'desktop';
});

describe('HouseRow', () => {
  it('shows each housemate with the book, a state line and a spoken sentence', async () => {
    share('a', [
      row(),
      row({ user_id: 4, username: 'maya', state: 'paused', title: 'Circe', chapter: 'Nine' }),
      row({
        user_id: 5,
        username: 'jo',
        state: 'recent',
        title: 'The Thursday Murder Club',
        chapter_index: null,
        updated_at: minutesAgo(1),
      }),
    ]);
    await render(<HouseRow connections={[conn('a', 'Hearthside')]} />);

    expect(screen.getByText('Listening in the house')).toBeTruthy();
    expect(screen.getByText('Hearthside · shared by choice')).toBeTruthy();
    const list = screen.getByLabelText('Listening in the house on Hearthside');
    expect(list.props.accessibilityRole).toBe('list');

    expect(
      screen.getByRole('button', { name: 'sam is listening to Unsouled, Chapter 4' }),
    ).toBeTruthy();
    expect(screen.getByText('Listening now · Chapter 4')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'maya paused Circe, Nine' })).toBeTruthy();
    expect(screen.getByText('Paused · Nine')).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'jo listened to The Thursday Murder Club earlier today',
      }),
    ).toBeTruthy();
    expect(screen.getByText('Earlier today')).toBeTruthy();
    // The live dot sits beside the one person listening now.
    expect(screen.getAllByTestId('house-live-dot')).toHaveLength(1);
  });

  it('opens the book page on the row’s own connection', async () => {
    share('b', [row({ library_id: 7, path: 'Sci-Fi/Leviathan Wakes' })]);
    await render(<HouseRow connections={[conn('b', 'Hearthside')]} />);
    await fireEvent.press(screen.getByTestId('house-card'));
    expect(mockOpenBook).toHaveBeenCalledWith('b', 7, 'Sci-Fi/Leviathan Wakes');
  });

  it('links to the sharing settings, on the Household page (8b-1)', async () => {
    share('a', [row()]);
    await render(<HouseRow connections={[conn('a', 'Hearthside')]} />);
    await fireEvent.press(screen.getByRole('link', { name: 'Sharing settings' }));
    expect(mockOpenHousehold).toHaveBeenCalledTimes(1);
  });

  it('is one section per server, and none where nobody is listening', async () => {
    share('a', [row()]);
    share('b', []);
    share('c', [row({ user_id: 9, username: 'leo', title: 'The Gruffalo' })]);
    await render(
      <HouseRow
        connections={[conn('a', 'Hearthside'), conn('b', 'Empty'), conn('c', "Maya's Shelf")]}
      />,
    );
    expect(screen.getAllByText('Listening in the house')).toHaveLength(2);
    expect(screen.getByTestId('house-row-a')).toBeTruthy();
    expect(screen.queryByTestId('house-row-b')).toBeNull();
    expect(screen.getByText("Maya's Shelf · shared by choice")).toBeTruthy();
  });

  it('renders nothing while loading, on an error, or for a server without household', async () => {
    // No data at all: loading, failed, or the hooks skipped an older server.
    await render(<HouseRow connections={[conn('a', 'Hearthside')]} />);
    expect(screen.queryByText('Listening in the house')).toBeNull();
    expect(screen.toJSON()).toBeNull();
  });

  it('renders nothing and never polls while the listener does not share', async () => {
    mockSettings.a = { share_listening: false };
    // A cached answer from before they turned sharing off.
    mockHouse.a = { sharing: true, listening: [row()] };
    await render(<HouseRow connections={[conn('a', 'Hearthside')]} />);
    expect(screen.toJSON()).toBeNull();
    expect(mockListening).toHaveBeenLastCalledWith('a', { enabled: false });
  });

  it('polls only while Home is the focused screen', async () => {
    share('a', [row()]);
    await render(<HouseRow connections={[conn('a', 'Hearthside')]} />);
    expect(mockListening).toHaveBeenLastCalledWith('a', { enabled: true });

    mockFocused = false;
    await render(<HouseRow connections={[conn('a', 'Hearthside')]} />);
    expect(mockListening).toHaveBeenLastCalledWith('a', { enabled: false });
  });

  it('lays the cards out by the measured width: a grid wide, one column on a phone', async () => {
    share('a', [row(), row({ user_id: 4, username: 'maya' })]);
    await render(<HouseRow connections={[conn('a', 'Hearthside')]} />);
    const grid = screen.getByTestId('house-row-a');
    await fireEvent(grid, 'layout', { nativeEvent: { layout: { width: 600, height: 80 } } });
    const widths = () =>
      screen
        .getAllByTestId('house-card-slot')
        .map((c) => (c.props.style as { width: number | string }).width);
    expect(widths()).toEqual([294, 294]);

    mockLayout = 'phone';
    await render(<HouseRow connections={[conn('a', 'Hearthside')]} />);
    await fireEvent(screen.getByTestId('house-row-a'), 'layout', {
      nativeEvent: { layout: { width: 360, height: 80 } },
    });
    expect(widths()).toEqual([360, 360]);
  });
});
