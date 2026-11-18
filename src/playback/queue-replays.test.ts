import { AppState } from 'react-native';

const mockFlushQueue = jest.fn(async () => {});
const mockFlushReading = jest.fn(async () => {});
jest.mock('@/api/address-route', () => ({ networkChecked: async () => {} }));
jest.mock('./progress-sync', () => ({ flushQueue: () => mockFlushQueue() }));
jest.mock('@/reader/reading-progress', () => ({ flushReadingQueue: () => mockFlushReading() }));

/* eslint-disable-next-line import/first */
import { startQueueReplays } from './queue-replays';

/** A window's listeners, by event. */
function fakeWindow() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener: (type: string, fn: () => void) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(fn));
    },
    removeEventListener: (type: string, fn: () => void) => void listeners.get(type)?.delete(fn),
    fire: (type: string) => listeners.get(type)?.forEach((fn) => fn()),
  };
}

describe('the stored queues replayed when the app is picked up again', () => {
  let appListener: ((state: string) => void) | null = null;
  const remove = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, fn) => {
      appListener = fn as (state: string) => void;
      return { remove } as never;
    });
  });
  afterEach(() => jest.restoreAllMocks());

  const checked = () => new Promise((r) => setTimeout(r, 0));

  it('replays on the window focused, the browser online and the tab shown again, until stopped', async () => {
    const win = fakeWindow();
    const stop = startQueueReplays(win as never);
    win.fire('focus');
    expect(mockFlushQueue).toHaveBeenCalledTimes(1);
    expect(mockFlushReading).toHaveBeenCalledTimes(1);
    win.fire('online');
    expect(mockFlushQueue).toHaveBeenCalledTimes(2);
    // Hidden, then shown again (the web's visibility, the app's foreground).
    appListener?.('background');
    expect(mockFlushQueue).toHaveBeenCalledTimes(2);
    appListener?.('active');
    await checked();
    expect(mockFlushQueue).toHaveBeenCalledTimes(3);
    expect(mockFlushReading).toHaveBeenCalledTimes(3);
    stop();
    win.fire('focus');
    win.fire('online');
    expect(mockFlushQueue).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalled();
  });

  it('off the web there is no window: the foreground alone', async () => {
    const stop = startQueueReplays(undefined);
    appListener?.('background');
    appListener?.('active');
    await checked();
    expect(mockFlushQueue).toHaveBeenCalledTimes(1);
    stop();
  });
});
