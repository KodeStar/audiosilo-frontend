import * as WebBrowser from 'expo-web-browser';
import { Linking, Platform } from 'react-native';

/**
 * GitHub Sponsors is the single place AudioSilo collects voluntary contributions.
 * It is a pure donation - no functionality is unlocked and no reward is given back -
 * so it stays a gift outside the scope of VAT. Keep it reward-free if that link to
 * GitHub Sponsors ever grows tiers.
 */
export const SUPPORT_URL = 'https://github.com/sponsors/KodeStar';

/**
 * Whether to surface the "Support" link on this platform.
 *
 * Hidden on iOS: Apple's App Store guidelines don't allow an app to link out to an
 * external developer-donation page, and the UK App Store sits outside both carve-outs
 * that now permit it elsewhere - the US (the Epic v. Apple injunction) and the EU (the
 * DMA). Web and Android are unrestricted (Google Play explicitly exempts donations),
 * and iOS users can still sponsor from the web player or the GitHub page directly.
 */
export function isSupportAvailable(): boolean {
  return Platform.OS !== 'ios';
}

/**
 * Open the GitHub Sponsors page. On web we want a normal new tab (`Linking` →
 * `window.open('_blank')`); `WebBrowser.openBrowserAsync` is avoided there because its
 * web path opens an OAuth-style centred popup window. On native (Android - iOS hides
 * the link entirely) `openBrowserAsync` gives a nicer in-app Custom Tab.
 */
export async function openSupport(): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      await Linking.openURL(SUPPORT_URL);
    } else {
      await WebBrowser.openBrowserAsync(SUPPORT_URL);
    }
  } catch {
    // user dismissed it, or no browser is available - nothing to recover from
  }
}
