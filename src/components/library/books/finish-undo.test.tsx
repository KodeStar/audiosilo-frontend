import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react-native';

import { ApiClient, ApiError } from '@/api/client';
import { qk } from '@/api/hooks';
import { ApiProvider, queryClient } from '@/api/provider';
import { useReachability } from '@/api/reachability';
import type { Book, ListeningSyncResponse, Progress } from '@/api/types';
import * as toasts from '@/components/ui/toast';
import { flushOutbox, outboxEvents } from '@/playback/listening-outbox';
import { readMirror, writeMirror } from '@/playback/progress-sync';
import { useSession } from '@/stores/session';

import { useBookActions } from './book-actions';

jest.mock('@/playback/service', () => ({ createPlaybackService: jest.fn() }));

// Exercise the menu, its mutation, the store's real finish recorder, the outbox and
// the durable mirror together, with controlled replies at the API client.
const connectionId = 'srv.1';
const libraryId = 3;
const path = 'Author/Book';
const book: Book = {
  id: 1,
  library_id: libraryId,
  rel_path: path,
  is_folder: true,
  title: 'Book',
  author: 'Author',
  series: '',
  series_index: 0,
  narrator: '',
  duration: 1000,
  format: 'mp3',
  size: 1,
};
const progress: Progress = {
  library_id: libraryId,
  path,
  position: 610,
  duration: book.duration,
  finished: false,
  playback_speed: 1.25,
  device_id: 'device',
  updated_at: '2026-01-01T00:00:00Z',
  version: 2,
};
const file = path + '/02.mp3';
const mirror = () => readMirror(connectionId, libraryId, path);

beforeAll(() => {
  const defaults = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...defaults,
    mutations: { ...defaults.mutations, gcTime: Infinity },
  });
});
beforeEach(async () => {
  await AsyncStorage.clear();
  queryClient.clear();
  useReachability.setState({ online: {} });
  useSession.setState({
    status: 'authenticated',
    connections: [
      {
        id: connectionId,
        serverId: 'srv',
        serverUrl: 'https://example.invalid',
        name: 'Books',
        token: 'test',
        user: {
          id: 1,
          username: 'reader',
          role: 'user',
          disabled: false,
          has_password: true,
          has_recovery: false,
        },
      },
    ],
    defaultConnectionId: connectionId,
  });
  queryClient.setQueryData(qk.server(connectionId), {
    server_id: 'srv',
    capabilities: { listening_sync: true, progress_edit: true },
  });
  queryClient.setQueryData(qk.libraries(connectionId), []);
  await writeMirror({ ...progress, connectionId, libraryId, file, file_pos: 10 });
});
afterEach(async () => {
  await cleanup();
  queryClient.clear();
  jest.restoreAllMocks();
});

async function markFromMenu() {
  const toast = jest.spyOn(toasts, 'toast').mockReturnValue(1);
  const { result } = await renderHook(
    () =>
      useBookActions(
        { connectionId, libraryId, book, progress },
        { openCollect: jest.fn(), confirmRemove: jest.fn() },
      ),
    { wrapper: ApiProvider },
  );
  await act(async () => result.current.find((item) => item.key === 'finish')!.onPress());
  await waitFor(() =>
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Marked as finished',
        action: expect.objectContaining({ label: 'Undo' }),
      }),
    ),
  );
  expect(await mirror()).toMatchObject({ finished: true, position: book.duration });
  const undo = toast.mock.calls.find(([options]) => options.title === 'Marked as finished')![0]
    .action!;
  return { undo, toast };
}

it('takes an offline Mark back from the outbox and restores the exact file without an edit', async () => {
  useReachability.setState({ online: { [connectionId]: false } });
  const sync = jest
    .spyOn(ApiClient.prototype, 'syncListening')
    .mockRejectedValue(new TypeError('offline'));
  const edit = jest.spyOn(ApiClient.prototype, 'editProgress').mockResolvedValue(progress);
  const { undo } = await markFromMenu();
  await flushOutbox(connectionId);
  expect((await outboxEvents(connectionId)).map((entry) => entry.event.kind)).toEqual(['finish']);
  await act(async () => undo.onPress());
  await waitFor(async () =>
    expect(await mirror()).toMatchObject({
      finished: false,
      position: 610,
      file,
      file_pos: 10,
      updated_at: progress.updated_at,
    }),
  );
  expect(await outboxEvents(connectionId)).toEqual([]);
  useReachability.setState({ online: {} });
  sync.mockClear();
  await flushOutbox(connectionId);
  expect(sync).not.toHaveBeenCalled();
  expect(edit).not.toHaveBeenCalled();
});

it('waits for an in-flight finish before editing, then keeps the unfinished place on disk', async () => {
  let answer!: () => void;
  const sync = jest.spyOn(ApiClient.prototype, 'syncListening').mockImplementation(
    ({ events }) =>
      new Promise<ListeningSyncResponse>((resolve) => {
        answer = () =>
          resolve({
            server_time: new Date().toISOString(),
            results: events.map(({ id }) => ({ id, status: 'applied' })),
            progress: [{ ...progress, position: book.duration, finished: true, version: 3 }],
          });
      }),
  );
  const edit = jest
    .spyOn(ApiClient.prototype, 'editProgress')
    .mockResolvedValue({ ...progress, version: 4 });
  const dismissed = jest.spyOn(toasts, 'dismissToast');
  const { undo, toast } = await markFromMenu();
  await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
  await act(async () => undo.onPress());
  await waitFor(() =>
    expect(toast).toHaveBeenCalledWith({
      title: 'Marking as not finished...',
      description: book.title,
      duration: null,
    }),
  );
  expect(edit).not.toHaveBeenCalled();
  expect(await mirror()).toMatchObject({ finished: true });
  await act(async () => answer());
  await waitFor(async () =>
    expect(await mirror()).toMatchObject({
      finished: false,
      position: 610,
      file,
      file_pos: 10,
    }),
  );
  expect(edit).toHaveBeenCalledTimes(1);
  expect(edit).toHaveBeenCalledWith(libraryId, path, { finished: false, position: 610 });
  expect(await outboxEvents(connectionId)).toEqual([]);
  expect(dismissed).toHaveBeenCalledWith(1);
});

it('keeps the same finish when an Undo cannot reach the server and restores the place on Retry', async () => {
  const lost = new ApiError(504, 'gateway timeout');
  jest.spyOn(ApiClient.prototype, 'syncListening').mockRejectedValue(lost);
  const edit = jest
    .spyOn(ApiClient.prototype, 'editProgress')
    .mockRejectedValueOnce(lost)
    .mockResolvedValue({ ...progress, version: 4 });
  const { undo, toast } = await markFromMenu();
  await flushOutbox(connectionId);
  const [finish] = await outboxEvents(connectionId);
  await act(async () => undo.onPress());
  await waitFor(() => expect(toast.mock.calls.at(-1)![0].action?.label).toBe('Retry'));
  expect(await outboxEvents(connectionId)).toMatchObject([{ event: finish.event }]);
  expect(await mirror()).toMatchObject({ finished: true, position: book.duration });
  await act(async () => toast.mock.calls.at(-1)![0].action!.onPress());
  await waitFor(async () =>
    expect(await mirror()).toMatchObject({
      finished: false,
      position: 610,
      file,
      file_pos: 10,
    }),
  );
  expect(edit).toHaveBeenCalledTimes(2);
  expect(await outboxEvents(connectionId)).toEqual([]);
});
