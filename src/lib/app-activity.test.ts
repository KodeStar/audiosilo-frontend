import { AppState } from 'react-native';

import { driveAppState } from '@/testing/app-state';

import { isAway, isOffScreen, onAppStateEdge } from './app-activity';

const { becomes } = driveAppState();

afterEach(() => becomes('active'));

describe('isAway and isOffScreen', () => {
  it('read the background as both, inactive as away only', () => {
    expect([isAway('active'), isOffScreen('active')]).toEqual([false, false]);
    expect([isAway('inactive'), isOffScreen('inactive')]).toEqual([true, false]);
    expect([isAway('background'), isOffScreen('background')]).toEqual([true, true]);
  });

  it('read a state that is none of them as in front', () => {
    for (const unknown of ['unknown', null, undefined]) {
      expect([isAway(unknown), isOffScreen(unknown)]).toEqual([false, false]);
    }
  });

  it('read the current state when given none', () => {
    becomes('background');
    expect([isAway(), isOffScreen()]).toEqual([true, true]);
  });
});

describe('onAppStateEdge', () => {
  it('tells each change of the reading once, not each change of state', () => {
    const away = jest.fn();
    const offScreen = jest.fn();
    onAppStateEdge(isAway, away);
    onAppStateEdge(isOffScreen, offScreen);
    becomes('inactive');
    becomes('background');
    becomes('inactive');
    becomes('active');
    becomes('active');
    expect(away.mock.calls).toEqual([[true], [false]]);
    expect(offScreen.mock.calls).toEqual([[true], [false]]);
  });

  it('starts from the state the app is in', () => {
    becomes('background');
    const fn = jest.fn();
    onAppStateEdge(isAway, fn);
    becomes('background');
    expect(fn).not.toHaveBeenCalled();
    becomes('active');
    expect(fn.mock.calls).toEqual([[false]]);
  });

  it('stops', () => {
    const fn = jest.fn();
    onAppStateEdge(isAway, fn)();
    becomes('background');
    expect(fn).not.toHaveBeenCalled();
  });

  it('does nothing where the platform gives no subscription (no document)', () => {
    (AppState.addEventListener as unknown as jest.Mock).mockImplementationOnce(() => undefined);
    expect(() => onAppStateEdge(isAway, jest.fn())()).not.toThrow();
  });
});
