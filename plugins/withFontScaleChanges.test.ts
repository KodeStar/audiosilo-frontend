import type { ExpoConfig } from 'expo/config';

import withFontScaleChanges, { addConfigChanges } from './withFontScaleChanges';

/** The SDK 58 template's main activity flags (an `expo prebuild` of this app). */
const TEMPLATE =
  'keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize|assetsPaths|locale|layoutDirection';

const manifest = (configChanges?: string) => ({
  manifest: {
    $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
    application: [
      {
        $: { 'android:name': '.MainApplication' },
        activity: [
          {
            $: {
              'android:name': '.MainActivity',
              ...(configChanges === undefined ? {} : { 'android:configChanges': configChanges }),
            },
          },
          { $: { 'android:name': '.OtherActivity', 'android:configChanges': 'orientation' } },
        ],
      },
    ],
  },
});

const changesOf = (m: ReturnType<typeof manifest>, name = '.MainActivity') =>
  m.manifest.application[0].activity.find((a) => a.$['android:name'] === name)!.$[
    'android:configChanges' as never
  ] as string;

describe('withFontScaleChanges (fe#267)', () => {
  it("adds fontScale and density to the template's flags, keeping them and their order", () => {
    const out = addConfigChanges(manifest(TEMPLATE) as never) as ReturnType<typeof manifest>;
    expect(changesOf(out)).toBe(`${TEMPLATE}|fontScale|density`);
    // Another activity is left alone.
    expect(changesOf(out, '.OtherActivity')).toBe('orientation');
  });

  it('adds each flag once, however often it runs, and fills an activity with none', () => {
    const twice = addConfigChanges(addConfigChanges(manifest(TEMPLATE) as never));
    expect(changesOf(twice as ReturnType<typeof manifest>)).toBe(`${TEMPLATE}|fontScale|density`);
    const partial = addConfigChanges(manifest('density|orientation') as never);
    expect(changesOf(partial as ReturnType<typeof manifest>)).toBe('density|orientation|fontScale');
    const none = addConfigChanges(manifest() as never);
    expect(changesOf(none as ReturnType<typeof manifest>)).toBe('fontScale|density');
  });

  it('runs as an Android manifest mod', async () => {
    const config = withFontScaleChanges({ name: 'AudioSilo', slug: 'audiosilo' } as ExpoConfig);
    type Mod = (c: Record<string, unknown>) => Promise<{ modResults: unknown }>;
    const mod = (config as unknown as { mods: { android: { manifest: Mod } } }).mods.android
      .manifest;
    const result = await mod({
      name: 'AudioSilo',
      slug: 'audiosilo',
      modResults: manifest(TEMPLATE),
      modRequest: {
        platform: 'android',
        modName: 'manifest',
        projectRoot: '/tmp/app',
        platformProjectRoot: '/tmp/app/android',
        introspect: false,
      },
    });
    expect(changesOf(result.modResults as ReturnType<typeof manifest>)).toContain(
      'fontScale|density',
    );
  });
});
