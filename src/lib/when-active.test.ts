import { AppState } from 'react-native';

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (h: unknown) => mockPush(h), replace: (h: unknown) => mockReplace(h) },
}));

/* eslint-disable import/first */
import { navigateWhenActive, onForeground, whenActive } from './when-active';
/* eslint-enable import/first */

let state: string;
let listeners: ((s: string) => void)[];

beforeEach(() => {
  state = 'active';
  listeners = [];
  Object.defineProperty(AppState, 'currentState', { get: () => state, configurable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _: string,
    l: (s: string) => void,
  ) => {
    listeners.push(l);
    return { remove: () => (listeners = listeners.filter((x) => x !== l)) };
  }) as unknown as typeof AppState.addEventListener);
});
afterEach(() => jest.restoreAllMocks());

const emit = (s: string) => [...listeners].forEach((l) => l(s));

describe('whenActive', () => {
  it('runs at once in the foreground', () => {
    const fn = jest.fn();
    whenActive(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(listeners).toHaveLength(0);
  });

  it('waits for the app to come back, then runs once', () => {
    state = 'background';
    const fn = jest.fn();
    whenActive(fn);
    emit('inactive');
    expect(fn).not.toHaveBeenCalled();
    emit('active');
    emit('active');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(listeners).toHaveLength(0);
  });

  it('can be cancelled', () => {
    state = 'background';
    const fn = jest.fn();
    whenActive(fn)();
    emit('active');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('onForeground', () => {
  it('runs on each return to the foreground, and onLeave on each leave', () => {
    const fn = jest.fn();
    const leave = jest.fn();
    const stop = onForeground(fn, leave);
    emit('active'); // already there: not a return
    expect(fn).not.toHaveBeenCalled();
    emit('inactive');
    emit('background');
    expect(leave).toHaveBeenCalledTimes(2);
    emit('active');
    expect(fn).toHaveBeenCalledTimes(1);
    emit('background');
    emit('active');
    expect(fn).toHaveBeenCalledTimes(2);
    stop();
    expect(listeners).toHaveLength(0);
  });

  it('counts a start in the background as away', () => {
    state = 'background';
    const fn = jest.fn();
    onForeground(fn);
    emit('active');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('navigateWhenActive', () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockReplace.mockReset();
  });

  it('pushes now in the foreground', () => {
    navigateWhenActive('/player');
    expect(mockPush).toHaveBeenCalledWith('/player');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('replaces the screen once the app is back', () => {
    state = 'background';
    navigateWhenActive('/player', { replace: true });
    expect(mockReplace).not.toHaveBeenCalled();
    emit('active');
    expect(mockReplace).toHaveBeenCalledWith('/player');
    expect(mockPush).not.toHaveBeenCalled();
  });
});
