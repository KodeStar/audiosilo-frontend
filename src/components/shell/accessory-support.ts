import { Platform } from 'react-native';

/**
 * Whether the native tab bar can host the mini player in its bottom accessory slot
 * (`UITabBarController.bottomAccessory`): iOS 26 and later. The app's deployment target
 * is iOS 16.4 and Android ignores the slot, so everywhere else the mini player is a card
 * floating above the tab bar instead.
 */
export const ACCESSORY_SUPPORTED =
  Platform.OS === 'ios' && parseInt(String(Platform.Version), 10) >= 26;

/** Two lines must share the system's roughly 48 pt accessory, including its progress line. */
export const ACCESSORY_TEXT_MAX_SCALE = 1.3;
