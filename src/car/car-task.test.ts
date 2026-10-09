const calls: string[] = [];
let mockCarConnected = false;
const mockStop = jest.fn();
jest.mock('@/lib/bootstrap', () => ({
  bootstrapPlayback: jest.fn(async () => {
    calls.push('bootstrap');
  }),
}));
jest.mock('@/api/address-runner', () => ({
  startAddressRouting: jest.fn(() => {
    calls.push('routing');
    return () => undefined;
  }),
}));
jest.mock('@/playback/place-reconcile', () => ({
  startPlaceReconcile: jest.fn(() => {
    calls.push('reconcile');
    return () => undefined;
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
jest.mock('./car-connection', () => ({ isCarConnected: () => mockCarConnected }));
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
  mockCarConnected = false;
  mockStop.mockClear();
  setState('idle');
});

afterEach(() => {
  jest.useRealTimers();
});

describe('runCarTask', () => {
  it('boots (the language among the launch steps), starts the address pick, the place reconcile and the car sync, then ends once idle (never stopping them)', async () => {
    setState('playing');
    let done = false;
    const task = runCarTask().then(() => {
      done = true;
    });
    await flush();
    expect(calls).toEqual(['bootstrap', 'routing', 'reconcile', 'start', 'ready']);
    await jest.advanceTimersByTimeAsync(CAR_TASK_IDLE_MS * 2);
    expect(done).toBe(false); // still playing
    setState('paused');
    await jest.advanceTimersByTimeAsync(CAR_TASK_IDLE_MS);
    await task;
    expect(done).toBe(true);
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('starts the address pick and the place reconcile once per runtime', async () => {
    setState('idle');
    const run = async () => {
      const task = runCarTask();
      await jest.advanceTimersByTimeAsync(CAR_TASK_IDLE_MS);
      await task;
    };
    await run();
    calls.length = 0;
    await run();
    expect(calls).toEqual(['bootstrap', 'start', 'ready']);
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

  it('stays while a car is connected, even with nothing playing, and ends once it leaves', async () => {
    mockCarConnected = true;
    let done = false;
    void untilIdle(30_000).then(() => {
      done = true;
    });
    await jest.advanceTimersByTimeAsync(120_000);
    expect(done).toBe(false); // the car's lists still need their timers
    mockCarConnected = false;
    mockConnection?.(false);
    await flush();
    expect(done).toBe(true);
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
