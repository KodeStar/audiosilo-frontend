import { AppState } from 'react-native';

import { whenActive } from './when-active';

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
