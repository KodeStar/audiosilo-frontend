import Constants from 'expo-constants';

/**
 * This build's bundled app version, read from app.json (`expo.version`) via
 * expo-constants - the single source of truth, so it can't drift the way a
 * hardcoded literal did. Empty string in the rare contexts where Constants is
 * unavailable; callers prefer the connected server's version when they have one.
 */
export const APP_VERSION: string = Constants.expoConfig?.version ?? '';
