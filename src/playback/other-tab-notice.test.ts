import { AppState } from 'react-native';

import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';
import es from '@/i18n/locales/es.json';
import fr from '@/i18n/locales/fr.json';
import italian from '@/i18n/locales/it.json';
import pt from '@/i18n/locales/pt.json';

const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));
jest.mock('expo-router', () => ({ router: { push: jest.fn(), replace: jest.fn() } }));
let mockGaveWay: (() => void) | null = null;
let mockState = 'paused';
jest.mock('./store', () => ({
  onGaveWayToTab: (listener: () => void) => {
    mockGaveWay = listener;
    return () => {
      if (mockGaveWay === listener) mockGaveWay = null;
    };
  },
  usePlayer: { getState: () => ({ snapshot: { state: mockState } }) },
}));

/* eslint-disable import/first */
import { startOtherTabNotice } from './other-tab-notice';
/* eslint-enable import/first */

let appState: string;
let listeners: ((s: string) => void)[];
const emit = (s: string) => {
  appState = s;
  [...listeners].forEach((l) => l(s));
};

beforeEach(() => {
  mockToast.mockClear();
  mockState = 'paused';
  appState = 'active';
  listeners = [];
  Object.defineProperty(AppState, 'currentState', { get: () => appState, configurable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _: string,
    l: (s: string) => void,
  ) => {
    listeners.push(l);
    return { remove: () => (listeners = listeners.filter((x) => x !== l)) };
  }) as unknown as typeof AppState.addEventListener);
});
afterEach(() => jest.restoreAllMocks());

describe('the "Playing in another tab" notice', () => {
  it('is shown at once in a tab that is looked at (its pause has not landed yet)', () => {
    const stop = startOtherTabNotice();
    mockState = 'playing'; // the pause is on its way
    mockGaveWay?.();
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith({ title: 'Playing in another tab' });
    stop();
  });

  it('waits in a hidden tab until it is looked at, and is shown once', () => {
    const stop = startOtherTabNotice();
    appState = 'background';
    mockGaveWay?.();
    mockGaveWay?.(); // gave way again while hidden
    expect(mockToast).not.toHaveBeenCalled();
    emit('active');
    expect(mockToast).toHaveBeenCalledTimes(1);
    stop();
  });

  it('is not shown in a hidden tab that plays again by the time it is looked at', () => {
    const stop = startOtherTabNotice();
    appState = 'background';
    mockGaveWay?.();
    mockState = 'playing'; // claimed back from the OS media controls
    emit('active');
    expect(mockToast).not.toHaveBeenCalled();
    stop();
  });

  it('stops with the services: nothing shown after, and nothing left waiting', () => {
    const stop = startOtherTabNotice();
    appState = 'background';
    mockGaveWay?.();
    stop();
    expect(mockGaveWay).toBeNull();
    emit('active');
    expect(mockToast).not.toHaveBeenCalled();
  });

  it.each(Object.entries({ en, de, es, fr, it: italian, pt }))(
    '%s has its words',
    (_language, catalog) => {
      expect(catalog.player.otherTab.title).toBeTruthy();
    },
  );
});
