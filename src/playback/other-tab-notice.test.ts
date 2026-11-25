import { AppState } from 'react-native';

import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';
import es from '@/i18n/locales/es.json';
import fr from '@/i18n/locales/fr.json';
import italian from '@/i18n/locales/it.json';
import pt from '@/i18n/locales/pt.json';
import { PROGRESS_MIRROR_KEY } from '@/lib/storage-keys';
import * as tabChannel from '@/lib/tab-channel';

const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));
jest.mock('expo-router', () => ({ router: { push: jest.fn(), replace: jest.fn() } }));
let mockGaveWay: ((reason?: 'gave-way' | 'cast-pause-failed') => void) | null = null;
let mockState = 'paused';
const mockShowPlace = jest.fn();
jest.mock('./store', () => ({
  showOtherTabsPlace: () => mockShowPlace(),
  onGaveWayToTab: (listener: NonNullable<typeof mockGaveWay>) => {
    mockGaveWay = listener;
    return () => {
      if (mockGaveWay === listener) mockGaveWay = null;
    };
  },
  usePlayer: { getState: () => ({ snapshot: { state: mockState } }) },
  selectIsTransportLive: () => mockState === 'playing' || mockState === 'loading',
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
  mockShowPlace.mockClear();
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

describe('the notice after another tab starts playing', () => {
  it('is shown at once in a tab that is looked at (its pause has not landed yet)', () => {
    const stop = startOtherTabNotice();
    mockState = 'playing'; // the pause is on its way
    mockGaveWay?.();
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith({ title: 'Playback started in another tab' });
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

  it.each(['playing', 'loading'])('is skipped when this tab is %s again on return', (state) => {
    const stop = startOtherTabNotice();
    appState = 'background';
    mockGaveWay?.();
    mockState = state;
    emit('active');
    expect(mockToast).not.toHaveBeenCalled();
    stop();
  });

  it('explains a receiver pause failure even when the receiver still reports playing', () => {
    const stop = startOtherTabNotice();
    appState = 'background';
    mockGaveWay?.('gave-way');
    mockGaveWay?.('cast-pause-failed');
    mockState = 'playing';
    emit('active');
    expect(mockToast.mock.calls).toEqual([[{ title: en.player.otherTab.castPauseFailed }]]);
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

  it('shows the place the other tab played to each time the tab is looked at again', () => {
    const stop = startOtherTabNotice();
    expect(mockShowPlace).not.toHaveBeenCalled();
    emit('background');
    emit('active');
    expect(mockShowPlace).toHaveBeenCalledTimes(1);
    emit('background');
    emit('active');
    expect(mockShowPlace).toHaveBeenCalledTimes(2);
    stop();
    emit('background');
    emit('active');
    expect(mockShowPlace).toHaveBeenCalledTimes(2);
  });

  it.each(Object.entries({ en, de, es, fr, it: italian, pt }))(
    '%s has its words',
    (_language, catalog) => {
      expect(catalog.player.otherTab.title).toBeTruthy();
      expect(catalog.player.otherTab.castPauseFailed).toBeTruthy();
    },
  );

  it('follows the other window’s saves while visible and reads again on return', () => {
    const unsubscribe = jest.fn();
    const watch = jest.spyOn(tabChannel, 'onStoredChange').mockReturnValue(unsubscribe);
    const stop = startOtherTabNotice();
    const [key, changed] = watch.mock.calls[0];
    expect(key).toBe(PROGRESS_MIRROR_KEY);
    changed('{}');
    expect(mockShowPlace).toHaveBeenCalledTimes(1);
    emit('background');
    changed('{}');
    expect(mockShowPlace).toHaveBeenCalledTimes(1);
    emit('active');
    expect(mockShowPlace).toHaveBeenCalledTimes(2);
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
