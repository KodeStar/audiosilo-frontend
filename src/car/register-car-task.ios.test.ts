const mockStartCarWork = jest.fn(async (_connected: () => boolean) => {});
jest.mock('./car-task', () => ({
  startCarWork: (connected: () => boolean) => mockStartCarWork(connected),
}));

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
  });

  it('starts the car work on a connect, handing on the connection as last heard', async () => {
    mockHandler!(true);
    await flush();
    expect(mockStartCarWork).toHaveBeenCalledTimes(1);
    const connected = mockStartCarWork.mock.calls[0][0];
    expect(connected()).toBe(true);
    mockHandler!(false);
    expect(connected()).toBe(false);
    // A later connect asks again; `startCarWork` itself runs once per runtime.
    mockHandler!(true);
    await flush();
    expect(mockStartCarWork).toHaveBeenCalledTimes(2);
  });
});
