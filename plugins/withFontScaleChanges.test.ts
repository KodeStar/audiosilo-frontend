import type { ExpoConfig } from 'expo/config';

import { MAIN_ACTIVITY_SDK58 } from './__fixtures__/main-activity-sdk58';
import withFontScaleChanges, {
  addConfigChanges,
  addConfigurationForward,
} from './withFontScaleChanges';

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

  it('fails the prebuild on a manifest with no main activity, rather than skip it', () => {
    const none = manifest(TEMPLATE);
    none.manifest.application[0].activity = none.manifest.application[0].activity.slice(1);
    expect(() => addConfigChanges(none as never)).toThrow(/MainActivity/);
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

  // React Native re-lays out text on the change but its DeviceInfo re-reads fontScale only on
  // resume, so JS never heard of a change made with the app in front (fe#267 verification).
  describe('MainActivity forwards the change to DeviceInfo', () => {
    it('adds the override and its imports to the SDK 58 template, once', () => {
      const out = addConfigurationForward(MAIN_ACTIVITY_SDK58);
      expect(out).toContain('override fun onConfigurationChanged(newConfig: Configuration) {');
      expect(out).toContain('super.onConfigurationChanged(newConfig)');
      expect(out).toContain(
        '(context?.getNativeModule("DeviceInfo") as? LifecycleEventListener)?.onHostResume()',
      );
      for (const i of [
        'android.content.res.Configuration',
        'com.facebook.react.ReactApplication',
        'com.facebook.react.bridge.LifecycleEventListener',
      ]) {
        expect(out.split('\n').filter((l) => l === `import ${i}`)).toHaveLength(1);
      }
      // Inside the class, after its opening line.
      expect(out.indexOf('override fun onConfigurationChanged')).toBeGreaterThan(
        out.indexOf('class MainActivity : ReactActivity() {'),
      );
      expect(addConfigurationForward(out)).toBe(out);
    });

    it('fails the prebuild where it cannot place the override', () => {
      expect(() => addConfigurationForward('package x\n\nclass Other {}\n')).toThrow(
        /MainActivity/,
      );
      const own = MAIN_ACTIVITY_SDK58.replace(
        'class MainActivity : ReactActivity() {\n',
        'class MainActivity : ReactActivity() {\n  override fun onConfigurationChanged(c: Configuration) {}\n',
      );
      expect(() => addConfigurationForward(own)).toThrow(/already overrides/);
    });

    it('runs as a main activity mod', async () => {
      const config = withFontScaleChanges({ name: 'AudioSilo', slug: 'audiosilo' } as ExpoConfig);
      type Mod = (c: Record<string, unknown>) => Promise<{ modResults: { contents: string } }>;
      const mod = (config as unknown as { mods: { android: { mainActivity: Mod } } }).mods.android
        .mainActivity;
      const result = await mod({
        name: 'AudioSilo',
        slug: 'audiosilo',
        modResults: { path: 'MainActivity.kt', language: 'kt', contents: MAIN_ACTIVITY_SDK58 },
        modRequest: {
          platform: 'android',
          modName: 'mainActivity',
          projectRoot: '/tmp/app',
          platformProjectRoot: '/tmp/app/android',
          introspect: false,
        },
      });
      expect(result.modResults.contents).toContain('onHostResume()');
    });
  });
});
