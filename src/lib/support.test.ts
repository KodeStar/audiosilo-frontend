import * as WebBrowser from 'expo-web-browser';
import { Linking, Platform } from 'react-native';

import { SUPPORT_URL, isSupportAvailable, openSupport } from './support';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
const openBrowserAsync = WebBrowser.openBrowserAsync as jest.Mock;

// support.ts branches on Platform.OS at call time, so we flip it per case.
function setPlatform(os: string) {
  (Platform as { OS: string }).OS = os;
}

describe('support', () => {
  let openURL: jest.SpyInstance;

  beforeEach(() => {
    openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  });

  afterEach(() => {
    setPlatform('ios');
    openBrowserAsync.mockReset();
    openURL.mockRestore();
  });

  it('points at the AudioSilo GitHub Sponsors page', () => {
    expect(SUPPORT_URL).toBe('https://github.com/sponsors/KodeStar');
  });

  describe('isSupportAvailable', () => {
    it('is hidden on iOS (App Store anti-steering rules)', () => {
      setPlatform('ios');
      expect(isSupportAvailable()).toBe(false);
    });

    it.each(['web', 'android'])('is shown on %s', (os) => {
      setPlatform(os);
      expect(isSupportAvailable()).toBe(true);
    });
  });

  describe('openSupport', () => {
    it('opens a new tab on web (not the popup-style in-app browser)', async () => {
      setPlatform('web');
      await openSupport();
      expect(openURL).toHaveBeenCalledWith(SUPPORT_URL);
      expect(openBrowserAsync).not.toHaveBeenCalled();
    });

    it('opens an in-app browser tab on native', async () => {
      setPlatform('android');
      openBrowserAsync.mockResolvedValue(undefined);
      await openSupport();
      expect(openBrowserAsync).toHaveBeenCalledWith(SUPPORT_URL);
      expect(openURL).not.toHaveBeenCalled();
    });

    it('swallows failures when no browser is available', async () => {
      setPlatform('android');
      openBrowserAsync.mockRejectedValue(new Error('no browser'));
      await expect(openSupport()).resolves.toBeUndefined();
    });
  });
});
