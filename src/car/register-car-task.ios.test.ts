import { isCarConnected } from './car-connection';

/** Whether a car was recorded as connected when the car work was asked to start. */
const connectedAtStart: boolean[] = [];
const mockStartCarWork = jest.fn(async () => {
  connectedAtStart.push(isCarConnected());
});
jest.mock('./car-task', () => ({ startCarWork: () => mockStartCarWork() }));

let mockHandler: ((connected: boolean) => void) | null = null;
const mockOnConnection = jest.fn((h: (connected: boolean) => void) => {
  mockHandler = h;
  return () => undefined;
});
jest.mock('./car-native', () => ({
  carNative: { onConnection: (h: (connected: boolean) => void) => mockOnConnection(h) },
}));

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('register-car-task (iOS)', () => {
  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./register-car-task.ios');
  });

  it('listens for the car at load, before any screen, and starts nothing without a car', async () => {
    expect(mockOnConnection).toHaveBeenCalledTimes(1);
    mockHandler!(false);
    await flush();
    expect(mockStartCarWork).not.toHaveBeenCalled();
    expect(isCarConnected()).toBe(false);
  });

  it('records a connect for the car sync (its own listener never hears the queued one) before starting the car work', async () => {
    mockHandler!(true);
    await flush();
    expect(mockStartCarWork).toHaveBeenCalledTimes(1);
    expect(connectedAtStart).toEqual([true]);
    mockHandler!(false);
    expect(isCarConnected()).toBe(false);
    // A later connect asks again; `startCarWork` itself runs once per runtime.
    mockHandler!(true);
    await flush();
    expect(mockStartCarWork).toHaveBeenCalledTimes(2);
  });

  it('logs a failed start', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockStartCarWork.mockRejectedValueOnce(new Error('boom'));
    mockHandler!(true);
    await flush();
    expect(warn).toHaveBeenCalledWith('[car] the car start failed', expect.any(Error));
    warn.mockRestore();
  });
});
