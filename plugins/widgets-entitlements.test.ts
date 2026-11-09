/* eslint-disable @typescript-eslint/no-require-imports -- config plugins are CommonJS */
const withWidgets = require('expo-widgets/app.plugin').default;
/* eslint-enable @typescript-eslint/no-require-imports */

// The app sends no push notifications, and an App Store build whose entitlements ask for
// push (`aps-environment`) needs the capability on its profile. expo-widgets 56 and 57
// added it unconditionally (a `withWidgetsNoPush` plugin stripped it); from 58 it adds it
// only when `enablePushNotifications` is on, which the app's config leaves off. This
// pins that: an expo-widgets bump that adds it again fails here.

type Mod = (c: Record<string, unknown>) => Promise<{ modResults: Record<string, unknown> }>;

/** Run the entitlements mods of `config` over `entitlements`, in the order prebuild does. */
async function entitlementsAfter(
  config: { mods: { ios: { entitlements: Mod } } },
  entitlements: object,
) {
  const result = await config.mods.ios.entitlements({
    ...config,
    modResults: { ...entitlements },
    modRequest: { platform: 'ios', modName: 'entitlements', introspect: true },
  });
  return result.modResults;
}

const GROUP = { 'com.apple.security.application-groups': ['group.app.audiosilo'] };

const base = () => ({
  name: 'AudioSilo',
  slug: 'audiosilo',
  ios: { bundleIdentifier: 'app.audiosilo' },
  // Prebuild sets this; expo-widgets' Android half asserts it even when disabled.
  _internal: { projectRoot: '/tmp/app' },
});

/** The app's expo-widgets options (app.json), without the widget list. */
function appWidgetOptions(): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { expo } = require('../app.json') as { expo: { plugins: unknown[] } };
  const entry = expo.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-widgets') as [
    string,
    Record<string, unknown>,
  ];
  return { ...entry[1], widgets: [] };
}

describe('expo-widgets entitlements', () => {
  it('asks for no push with the app config, keeping the App Group', async () => {
    const options = appWidgetOptions();
    expect(options.enablePushNotifications).toBeUndefined();
    const config = withWidgets(base(), options);
    expect(await entitlementsAfter(config, GROUP)).toEqual(GROUP);
  });

  it('adds push only when asked for', async () => {
    const config = withWidgets(base(), { ...appWidgetOptions(), enablePushNotifications: true });
    expect((await entitlementsAfter(config, GROUP))['aps-environment']).toBeDefined();
  });
});
