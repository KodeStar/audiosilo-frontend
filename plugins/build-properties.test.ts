import appJson from '../app.json';

type Options = Record<string, Record<string, unknown>>;

/** The `expo-build-properties` options app.json gives the native builds. */
function buildProperties(): Options {
  const plugins: unknown[] = appJson.expo.plugins;
  const entry = plugins.find((p) => Array.isArray(p) && p[0] === 'expo-build-properties');
  if (!entry) throw new Error('expo-build-properties is not configured');
  return (entry as [string, Options])[1];
}

describe('expo-build-properties', () => {
  // A server on plain http (TLS off, or a self-signed server's home http) must be
  // reachable from a release build, as on iOS (NSAllowsArbitraryLoads): Android allows
  // cleartext only in the debug manifest unless the main one says so. Media3's
  // DefaultHttpDataSource follows the same policy, so streaming needs it too.
  it('allows cleartext http on Android', () => {
    expect(buildProperties().android).toMatchObject({ usesCleartextTraffic: true });
  });

  // Load-bearing for the iOS link (see CLAUDE.md, "iOS build needs TWO workarounds").
  it('builds React Native from source on iOS', () => {
    expect(buildProperties().ios).toMatchObject({ buildReactNativeFromSource: true });
  });
});
