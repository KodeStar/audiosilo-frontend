import { appLinkPath } from '@/lib/native-intent';

/**
 * Expo Router's hook for links arriving from outside the app, on a cold start and while it
 * runs: the app's own links open as paths, so their query values arrive intact (see
 * `appLinkPath`).
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return appLinkPath(path);
}
