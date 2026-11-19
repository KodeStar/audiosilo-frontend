import { act, render } from '@testing-library/react-native';

import type { Bookmark } from '@/api/types';

import type { QueuedBookmark } from './annotation-outbox';

// One book's waiting bookmarks (fe#356): never a second time beside the listed one the
// server already holds (sent, not yet out of the outbox).
const mockQueue: QueuedBookmark[] = [];
jest.mock('./annotation-outbox', () => ({
  heldOnServer: jest.requireActual('./annotation-outbox').heldOnServer,
  loadQueuedBookmarks: async () => {},
  onQueuedBookmarksChange: () => () => {},
  queuedBookmarksSnapshot: () => mockQueue,
}));

/* eslint-disable import/first */
import { useQueuedBookmarks } from './use-queued-bookmarks';
/* eslint-enable import/first */

const waiting = (id: string, position: number): QueuedBookmark => ({
  id,
  connectionId: 'c1',
  libraryId: 1,
  path: 'a/book',
  position,
  note: '',
  updated_at: '2026-11-19T10:00:00.000Z',
});
const listed = (position: number): Bookmark => ({
  id: position,
  library_id: 1,
  path: 'a/book',
  position,
  note: '',
  created_at: '2026-11-19T10:00:00.000Z',
});

async function ids(onServer?: Bookmark[]): Promise<string[]> {
  const ref: { value: readonly QueuedBookmark[] } = { value: [] };
  function Probe() {
    ref.value = useQueuedBookmarks('c1', 1, 'a/book', onServer);
    return null;
  }
  await act(async () => {
    render(<Probe />);
  });
  return ref.value.map((e) => e.id);
}

beforeEach(() => {
  mockQueue.length = 0;
  mockQueue.push(waiting('w1', 100), waiting('w2', 200));
});

it('lists every waiting one while the server list is not known', async () => {
  expect(await ids()).toEqual(['w1', 'w2']);
});

it('leaves out one the server already lists', async () => {
  expect(await ids([listed(100)])).toEqual(['w2']);
});
