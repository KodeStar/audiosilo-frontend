const calls: string[] = [];
const mockStop = jest.fn();
jest.mock('@/lib/bootstrap', () => ({
  bootstrapPlayback: jest.fn(async () => {
    calls.push('bootstrap');
  }),
}));
jest.mock('@/i18n/language-provider', () => ({
  restoreLanguage: jest.fn(async () => {
    calls.push('language');
  }),
}));
jest.mock('./car-controller', () => ({
  startCarSync: jest.fn(() => {
    calls.push('start');
    return mockStop;
  }),
  carSyncReady: jest.fn(async () => {
    calls.push('ready');
  }),
}));
let mockConnection: ((connected: boolean) => void) | null = null;
jest.mock('./car-native', () => ({
  carNative: {
    onConnection: (h: (connected: boolean) => void) => {
      mockConnection = h;
      return () => {
        mockConnection = null;
      };
    },
  },
}));
jest.mock('@/playback/store', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { create } = require('zustand');
  return {
    usePlayer: create(() => ({ snapshot: { state: 'idle' } })),
    selectIsTransportLive: (s: { snapshot: { state: string } }) =>
      s.snapshot.state === 'playing' || s.snapshot.state === 'loading',
  };
});

/* eslint-disable import/first */
import { usePlayer } from '@/playback/store';

import { CAR_TASK_IDLE_MS, runCarTask, untilIdle } from './car-task';
/* eslint-enable import/first */

const setState = (state: string) =>
  (usePlayer as unknown as { setState: (s: object) => void }).setState({ snapshot: { state } });

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers();
  calls.length = 0;
  mockStop.mockClear();
  setState('idle');
});

afterEach(() => {
  jest.useRealTimers();
});

describe('runCarTask', () => {
  it('boots, applies the language, starts the car sync, then ends once idle (never stopping the sync)', async () => {
    setState('playing');
    let done = false;
    const task = runCarTask().then(() => {
      done = true;
    });
    await flush();
    expect(calls).toEqual(['bootstrap', 'language', 'start', 'ready']);
    await jest.advanceTimersByTimeAsync(CAR_TASK_IDLE_MS * 2);
    expect(done).toBe(false); // still playing
    setState('paused');
    await jest.advanceTimersByTimeAsync(CAR_TASK_IDLE_MS);
    await task;
    expect(done).toBe(true);
    expect(mockStop).not.toHaveBeenCalled();
  });
});

describe('untilIdle', () => {
  it('waits for the player to stay idle for the whole window', async () => {
    let done = false;
    void untilIdle(30_000).then(() => {
      done = true;
    });
    await jest.advanceTimersByTimeAsync(20_000);
    setState('playing'); // picked up again: the window starts over
    await jest.advanceTimersByTimeAsync(20_000);
    setState('paused');
    await jest.advanceTimersByTimeAsync(29_000);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(true);
  });

  it('counts a buffering book as live', async () => {
    setState('loading');
    let done = false;
    void untilIdle(30_000).then(() => {
      done = true;
    });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(done).toBe(false);
  });

  it('ends at once when the car leaves while nothing plays, not while a book plays', async () => {
    setState('playing');
    let done = false;
    void untilIdle(30_000).then(() => {
      done = true;
    });
    mockConnection?.(false);
    await flush();
    expect(done).toBe(false);
    setState('paused');
    mockConnection?.(false);
    await flush();
    expect(done).toBe(true);
    expect(mockConnection).toBeNull(); // its listeners are gone
  });

  it('notices the window is over on the next player change when timers were held', async () => {
    let done = false;
    void untilIdle(30_000).then(() => {
      done = true;
    });
    // Android held the JS timers (screen off): the clock moved on without them firing.
    jest.setSystemTime(Date.now() + 31_000);
    setState('ended');
    await flush();
    expect(done).toBe(true);
  });
});
