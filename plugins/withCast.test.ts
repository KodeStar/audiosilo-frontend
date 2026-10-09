import type { ExpoConfig } from 'expo/config';

import { APP_DELEGATE_SDK56 } from './__fixtures__/app-delegate-sdk56';
import withCarPlay from './withCarPlay';
import withCast, { addExpandedController, CAST_FRAMEWORK_VERSION } from './withCast';

type Mod = (config: Record<string, unknown>) => Promise<{ modResults: unknown }>;

/** The plugins as app.json lists them (withCast BEFORE withCarPlay), applied to a bare
 * config: returns the composed mod of `platform.mod`, which runs every plugin's edit in
 * Expo's real order (the last registered first). */
function composed(platform: 'ios' | 'android', mod: string): Mod {
  let config = { name: 'AudioSilo', slug: 'audiosilo' } as ExpoConfig;
  config = withCast(config);
  config = withCarPlay(config);
  const mods = (config as unknown as { mods: Record<string, Record<string, Mod>> }).mods;
  return mods[platform][mod];
}

async function runMod(platform: 'ios' | 'android', mod: string, modResults: unknown) {
  const result = await composed(
    platform,
    mod,
  )({
    name: 'AudioSilo',
    slug: 'audiosilo',
    modResults,
    modRequest: {
      platform,
      modName: mod,
      projectRoot: '/tmp/app',
      platformProjectRoot: `/tmp/app/${platform}`,
      introspect: false,
    },
  });
  return result.modResults;
}

describe('withCast + withCarPlay: the SDK 56 AppDelegate', () => {
  it('runs both plugins: CarPlay matches the template, then Cast adds its setup', async () => {
    const out = (await runMod('ios', 'appDelegate', {
      contents: APP_DELEGATE_SDK56,
      language: 'swift',
      path: 'AppDelegate.swift',
    })) as { contents: string };
    const src = out.contents;
    // withCarPlay's exact match succeeded (it throws otherwise) and its starter is in.
    expect(src).toContain('AudiosiloScenes.configure(');
    expect(src).toContain('internal import AudiosiloPlayer');
    expect(src).not.toContain('UIWindow(frame: UIScreen.main.bounds)');
    // The Cast SDK is set up in didFinishLaunching, before the React Native delegate.
    expect(src).toContain('import GoogleCast');
    expect(src.indexOf('import GoogleCast')).toBeLessThan(src.indexOf('import React\n'));
    const setup = src.indexOf('GCKCastContext.setSharedInstanceWith(options)');
    expect(setup).toBeGreaterThan(0);
    expect(setup).toBeLessThan(src.indexOf('let delegate = ReactNativeDelegate()'));
    expect(src).toContain('let receiverAppID = "CC1AD845"');
    expect(src).toContain('options.startDiscoveryAfterFirstTapOnCastButton = true');
    expect(src).toContain('options.suspendSessionsWhenBackgrounded = true');
    // No automatic expanded controls: the app's full player is the controller.
    expect(src).toContain('useDefaultExpandedMediaControls = false');
  });

  it("never touches what withCarPlay matches: Cast's edits first compose as well", async () => {
    // Expo applies the last registered mod first. Were withCast ever listed after
    // withCarPlay, withCarPlay would see Cast's edits: its exact match must still hold.
    let config = { name: 'AudioSilo', slug: 'audiosilo' } as ExpoConfig;
    config = withCarPlay(config);
    config = withCast(config);
    const mod = (config as unknown as { mods: Record<string, Record<string, Mod>> }).mods.ios
      .appDelegate;
    const out = (await mod({
      modResults: { contents: APP_DELEGATE_SDK56, language: 'swift', path: 'AppDelegate.swift' },
      modRequest: { platform: 'ios', modName: 'appDelegate', introspect: false },
    })) as { modResults: { contents: string } };
    expect(out.modResults.contents).toContain('AudiosiloScenes.configure(');
    expect(out.modResults.contents).toContain('GCKCastContext.setSharedInstanceWith(options)');
  });
});

describe('withCast: Info.plist', () => {
  it('adds the Cast Bonjour services and keeps our local network wording', async () => {
    const ours =
      'AudioSilo uses your local network to reach your AudioSilo server and to find Cast devices to play on.';
    const out = (await runMod('ios', 'infoPlist', {
      NSLocalNetworkUsageDescription: ours,
    })) as Record<string, unknown>;
    expect(out.NSBonjourServices).toEqual(['_googlecast._tcp', '_CC1AD845._googlecast._tcp']);
    expect(out.NSLocalNetworkUsageDescription).toBe(ours);
    // CarPlay's scene manifest is still written alongside.
    expect(out.UIApplicationSceneManifest).toBeDefined();
  });
});

describe('withCast: Android', () => {
  const manifest = () => ({
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      application: [
        {
          $: { 'android:name': '.MainApplication' },
          activity: [{ $: { 'android:name': '.MainActivity' } }],
        },
      ],
    },
  });

  it('declares the options provider and the expanded controller the notification opens', async () => {
    const out = (await runMod('android', 'manifest', manifest())) as ReturnType<typeof manifest>;
    const app = out.manifest.application[0] as unknown as {
      activity: { $: Record<string, string> }[];
      'meta-data': { $: Record<string, string> }[];
    };
    expect(app['meta-data']).toEqual(
      expect.arrayContaining([
        {
          $: {
            'android:name': 'com.google.android.gms.cast.framework.OPTIONS_PROVIDER_CLASS_NAME',
            'android:value': 'com.reactnative.googlecast.GoogleCastOptionsProvider',
          },
        },
        {
          $: {
            'android:name': 'com.reactnative.googlecast.RECEIVER_APPLICATION_ID',
            'android:value': 'CC1AD845',
          },
        },
      ]),
    );
    const names = app.activity.map((a) => a.$['android:name']);
    expect(names).toEqual([
      '.MainActivity',
      'com.reactnative.googlecast.RNGCExpandedControllerActivity',
    ]);
  });

  it('declares the expanded controller once, however often it runs', () => {
    const once = addExpandedController(manifest() as never);
    const twice = addExpandedController(once);
    const acts = (twice as ReturnType<typeof manifest>).manifest.application[0].activity;
    expect(acts.filter((a) => a.$['android:name'].includes('Expanded'))).toHaveLength(1);
  });

  it('pins play-services-cast-framework (never the plugin default `+`)', async () => {
    const project = (await runMod('android', 'projectBuildGradle', {
      language: 'groovy',
      contents: 'buildscript {\n  ext {\n    minSdkVersion = 24\n  }\n}\n',
    })) as { contents: string };
    expect(project.contents).toContain(`castFrameworkVersion = "${CAST_FRAMEWORK_VERSION}"`);
    const app = (await runMod('android', 'appBuildGradle', {
      language: 'groovy',
      contents: 'apply plugin: "com.android.application"\n\ndependencies {\n}\n',
    })) as { contents: string };
    expect(app.contents).toContain(
      `play-services-cast-framework:\${safeExtGet('castFrameworkVersion', '${CAST_FRAMEWORK_VERSION}')}`,
    );
    expect(CAST_FRAMEWORK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('initialises the Cast context in MainActivity.onCreate (guarded by the library)', async () => {
    const out = (await runMod('android', 'mainActivity', {
      language: 'kt',
      path: 'MainActivity.kt',
      contents:
        'package app.audiosilo\n\nimport android.os.Bundle\n\nclass MainActivity {\n  override fun onCreate(savedInstanceState: Bundle?) {\n    super.onCreate(null)\n  }\n}\n',
    })) as { contents: string };
    expect(out.contents).toContain('RNGCCastContext.getSharedInstance(this)');
  });
});
