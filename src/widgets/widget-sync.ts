/**
 * The widgets are iOS only (expo-widgets' Android side is a stub, and the web has none),
 * so everywhere else starting the sync does nothing. The real one is `widget-sync.ios.ts`;
 * Metro picks it by platform.
 */
export function startWidgetSync(): () => void {
  return () => {};
}
