import { AppState } from 'react-native';

import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';
import es from '@/i18n/locales/es.json';
import fr from '@/i18n/locales/fr.json';
import italian from '@/i18n/locales/it.json';
import pt from '@/i18n/locales/pt.json';

const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));
let mockEnded: (() => void) | null = null;
jest.mock('./store', () => ({
  onPartialDownloadEnd: (listener: () => void) => {
    mockEnded = listener;
    return () => {
      if (mockEnded === listener) mockEnded = null;
    };
  },
}));

/* eslint-disable import/first */
import { startPartialDownloadNotice } from './partial-download-notice';
/* eslint-enable import/first */

let appState: string;
let listeners: ((s: string) => void)[];
const emit = (s: string) => {
  appState = s;
  [...listeners].forEach((l) => l(s));
};

beforeEach(() => {
  mockToast.mockClear();
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

describe('the "rest of this book isn\'t downloaded" notice (D3, fe#185)', () => {
  it('is shown at once in the foreground', () => {
    const stop = startPartialDownloadNotice();
    mockEnded?.();
    expect(mockToast).toHaveBeenCalledTimes(1);
    stop();
  });

  it('waits for the app to be looked at, and shows once however often it stopped meanwhile', () => {
    appState = 'background';
    const stop = startPartialDownloadNotice();
    mockEnded?.();
    mockEnded?.();
    expect(mockToast).not.toHaveBeenCalled();
    emit('active');
    expect(mockToast).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stops listening when stopped', () => {
    const stop = startPartialDownloadNotice();
    stop();
    expect(mockEnded).toBeNull();
  });

  it('is worded in every locale', () => {
    for (const locale of [en, de, es, fr, italian, pt]) {
      expect(locale.player.partialDownload.title).toBeTruthy();
    }
    expect(en.player.partialDownload.title).toBe("The rest of this book isn't downloaded");
  });
});
