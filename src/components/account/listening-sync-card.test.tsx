import { fireEvent, render, screen } from '@testing-library/react-native';

import type { CouldNotSync } from '@/playback/listening-outbox';

const rejected: CouldNotSync = {
  event: {
    id: 'event-1',
    library_id: 1,
    path: 'Author/Book',
    kind: 'finish',
    at: '2026-11-06T12:00:00Z',
  },
  reason: 'duration_mismatch',
  at: '2026-11-06T12:00:00Z',
};
let mockSync = { waiting: 0, failed: [] as CouldNotSync[] };
const mockDiscard = jest.fn();
jest.mock('@/playback/use-listening-sync', () => ({ useListeningSync: () => mockSync }));
jest.mock('@/playback/listening-outbox', () => ({
  discardFailed: (...args: unknown[]) => mockDiscard(...args),
}));

/* eslint-disable import/first */
import { ListeningSyncCard } from './listening-sync-card';
/* eslint-enable import/first */

beforeEach(() => {
  mockSync = { waiting: 0, failed: [] };
  mockDiscard.mockReset();
});

it('acknowledges rejected events even with nothing waiting, and discards the same event', async () => {
  mockSync.failed = [rejected];
  const view = await render(<ListeningSyncCard connectionId="home" serverName="Home" supported />);
  expect(screen.getByText("1 listening event couldn't sync")).toBeTruthy();
  expect(screen.queryByText('Everything you listened to is on Home.')).toBeNull();
  expect(
    screen.getByText("This copy of the book is a different length from the server's."),
  ).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Discard Book · Marked finished' }));
  expect(mockDiscard).toHaveBeenCalledWith('home', 'event-1');
  mockSync = { waiting: 0, failed: [] };
  await view.rerender(<ListeningSyncCard connectionId="home" serverName="Home" supported />);
  expect(screen.getByText('Everything you listened to is on Home.')).toBeTruthy();
});

it('counts both waiting and rejected listens in its summary', async () => {
  mockSync = { waiting: 2, failed: [rejected] };
  await render(<ListeningSyncCard connectionId="home" serverName="Home" supported />);
  expect(
    screen.getByText("2 listens waiting to sync · 1 listening event couldn't sync"),
  ).toBeTruthy();
  expect(screen.queryByText('Everything you listened to is on Home.')).toBeNull();
});

it('still shows rejected events after support is removed, hiding only an empty unsupported card', async () => {
  mockSync.failed = [rejected];
  const view = await render(
    <ListeningSyncCard connectionId="home" serverName="Home" supported={false} />,
  );
  expect(screen.getByTestId('listening-sync-card')).toBeTruthy();
  mockSync.failed = [];
  await view.rerender(
    <ListeningSyncCard connectionId="home" serverName="Home" supported={false} />,
  );
  expect(screen.queryByTestId('listening-sync-card')).toBeNull();
});
