/* eslint-disable @typescript-eslint/no-require-imports -- config plugins are CommonJS */
const withWidgetsNoPush = require('./withWidgetsNoPush');
const withWidgets = require('expo-widgets/app.plugin').default;
/* eslint-enable @typescript-eslint/no-require-imports */

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
const WIDGETS = {
  bundleIdentifier: 'app.audiosilo.widget',
  groupIdentifier: 'group.app.audiosilo',
  widgets: [],
};

describe('withWidgetsNoPush', () => {
  it('removes the push entitlement expo-widgets adds, keeping the App Group', async () => {
    // app.json order: this plugin, then expo-widgets (mods run in reverse).
    const config = withWidgets(withWidgetsNoPush(base()), WIDGETS);
    const out = await entitlementsAfter(config, GROUP);
    expect(out).toEqual(GROUP);
  });

  it('is needed: expo-widgets alone adds it', async () => {
    const config = withWidgets(base(), WIDGETS);
    const out = await entitlementsAfter(config, {});
    expect(out['aps-environment']).toBe('development');
  });

  it('leaves every other entitlement alone', () => {
    expect(
      withWidgetsNoPush.stripPushEntitlement({ 'aps-environment': 'production', a: 1 }),
    ).toEqual({ a: 1 });
  });
});
