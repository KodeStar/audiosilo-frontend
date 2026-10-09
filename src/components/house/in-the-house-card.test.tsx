import { render, screen } from '@testing-library/react-native';

import type { HouseListening, HouseListeningRow, HouseholdSettings } from '@/api/types';

let mockFocused = true;
jest.mock('expo-router', () => ({ useIsFocused: () => mockFocused }));
let mockSettings: HouseholdSettings | undefined;
let mockHouse: HouseListening | undefined;
const mockListening = jest.fn();
jest.mock('@/api/hooks', () => ({
  useHousehold: () => ({ data: mockSettings }),
  useHouseListening: (cid: string, opts: { enabled?: boolean }) => {
    mockListening(cid, opts);
    return { data: mockHouse };
  },
}));

/* eslint-disable import/first */
import { InTheHouseCard } from './in-the-house-card';
/* eslint-enable import/first */

function row(over: Partial<HouseListeningRow> = {}): HouseListeningRow {
  return {
    user_id: 3,
    username: 'sam',
    library_id: 1,
    path: 'Will Wight/Unsouled',
    title: 'Unsouled',
    author: null,
    state: 'playing',
    position: 100,
    duration: null,
    chapter: null,
    chapter_index: 3,
    updated_at: new Date().toISOString(),
    ...over,
  };
}

const card = <InTheHouseCard connectionId="c1" libraryId={1} path="Will Wight/Unsouled" />;

beforeEach(() => {
  mockSettings = { share_listening: true };
  mockHouse = undefined;
  mockFocused = true;
  mockListening.mockReset();
});

describe('InTheHouseCard', () => {
  it('lists only the housemates on this book', async () => {
    mockHouse = {
      sharing: true,
      listening: [
        row(),
        row({ user_id: 4, username: 'maya', state: 'paused', chapter: 'Nine' }),
        // The same path in another library, and another book: not this one.
        row({ user_id: 5, username: 'jo', library_id: 2 }),
        row({ user_id: 6, username: 'leo', path: 'Will Wight/Soulsmith' }),
      ],
    };
    await render(card);
    expect(screen.getByText('In the house')).toBeTruthy();
    expect(screen.getByLabelText('sam is listening to Unsouled, Chapter 4')).toBeTruthy();
    expect(screen.getByText('Listening now · Chapter 4')).toBeTruthy();
    expect(screen.getByLabelText('maya paused Unsouled, Nine')).toBeTruthy();
    expect(screen.queryByText('jo')).toBeNull();
    expect(screen.queryByText('leo')).toBeNull();
    expect(mockListening).toHaveBeenLastCalledWith('c1', { enabled: true });
  });

  it('renders nothing when nobody who shares is on this book', async () => {
    mockHouse = { sharing: true, listening: [row({ path: 'Will Wight/Soulsmith' })] };
    await render(card);
    expect(screen.toJSON()).toBeNull();
  });

  it('renders nothing while loading or while the listener does not share', async () => {
    await render(card);
    expect(screen.toJSON()).toBeNull();

    mockSettings = { share_listening: false };
    mockHouse = { sharing: true, listening: [row()] };
    await render(card);
    expect(screen.toJSON()).toBeNull();
    expect(mockListening).toHaveBeenLastCalledWith('c1', { enabled: false });
  });

  it('does not poll while the page is not focused', async () => {
    mockFocused = false;
    mockHouse = { sharing: true, listening: [row()] };
    await render(card);
    expect(mockListening).toHaveBeenLastCalledWith('c1', { enabled: false });
    // The cached answer still shows.
    expect(screen.getByText('In the house')).toBeTruthy();
  });
});
