import {
  applyCarPlayEntitlement,
  applySceneManifest,
  CARPLAY_ENTITLEMENT,
  patchAppDelegate,
} from './withCarPlay';
import { APP_DELEGATE_SDK58 } from './__fixtures__/app-delegate-sdk58';

const template = APP_DELEGATE_SDK58;

describe('withCarPlay: Info.plist scene manifest', () => {
  it('declares the phone and CarPlay scenes and keeps the rest of the plist', () => {
    const out = applySceneManifest({ CFBundleDisplayName: 'AudioSilo' }) as Record<string, unknown>;
    expect(out.CFBundleDisplayName).toBe('AudioSilo');
    expect(out.UIApplicationSceneManifest).toEqual({
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Phone',
            UISceneDelegateClassName: 'AudiosiloPhoneSceneDelegate',
          },
        ],
        CPTemplateApplicationSceneSessionRoleApplication: [
          {
            UISceneClassName: 'CPTemplateApplicationScene',
            UISceneConfigurationName: 'CarPlay',
            UISceneDelegateClassName: 'AudiosiloCarPlaySceneDelegate',
          },
        ],
      },
    });
  });
});

describe('withCarPlay: AppDelegate', () => {
  it('stores the scene starter right after the factory is made', () => {
    const out = patchAppDelegate(template);
    expect(out).toContain('\ninternal import AudiosiloPlayer');
    expect(out).toContain('mirrorWindow: { [weak self] window in self?.window = window }');
    // The starter starts "main" with the scene's window and launch options...
    expect(out).toMatch(/withModuleName: "main",\s*in: window,\s*launchOptions: options\)/);
    // ...after the factory is made and kept, before didFinishLaunching returns.
    const kept = out.indexOf('reactNativeFactory = factory');
    const starter = out.indexOf('AudiosiloScenes.configure(');
    const ret = out.indexOf('return super.application(application, didFinishLaunchingWithOptions');
    expect(kept).toBeGreaterThan(0);
    expect(starter).toBeGreaterThan(kept);
    expect(ret).toBeGreaterThan(starter);
    // The template's note that its SceneDelegate starts React Native is gone (ours do).
    expect(out).not.toContain('started by `SceneDelegate`');
    // Once each.
    expect(out.split('AudiosiloScenes.configure(')).toHaveLength(2);
  });

  it('adds the linking overrides the phone scene forwards to, calling RCTLinkingManager', () => {
    const out = patchAppDelegate(template);
    expect(out).toContain(
      'return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)',
    );
    expect(out).toContain(
      'let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)',
    );
    expect(out).toContain(
      'return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result',
    );
    // Inside AppDelegate (after didFinishLaunching), not in ReactNativeDelegate below it.
    const open = out.indexOf('open url: URL');
    expect(open).toBeGreaterThan(out.indexOf('didFinishLaunchingWithOptions: launchOptions)'));
    expect(open).toBeLessThan(out.indexOf('class ReactNativeDelegate'));
    expect(out.split('open url: URL')).toHaveLength(2);
  });

  it('is idempotent', () => {
    const once = patchAppDelegate(template);
    expect(patchAppDelegate(once)).toBe(once);
  });

  it('fails loudly when the factory anchor is missing', () => {
    const changed = template.replace('reactNativeFactory = factory', 'self.factory = factory');
    expect(() => patchAppDelegate(changed)).toThrow(
      /does not match the Expo SDK 58 template \(no `reactNativeFactory = factory`\)/,
    );
  });

  it('fails loudly when the `return super` anchor is missing', () => {
    const changed = template.replace(
      'return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
      'return true',
    );
    expect(() => patchAppDelegate(changed)).toThrow(/no `return super\.application/);
  });

  it('fails loudly on an older template (no factory provider conformance, its own window)', () => {
    const older = template.replace(
      'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {',
      'class AppDelegate: ExpoAppDelegate {',
    );
    expect(() => patchAppDelegate(older)).toThrow(/ExpoReactNativeFactoryProvider/);
  });

  it('fails loudly when the template already handles links itself', () => {
    const changed = template.replace(
      /\n\}\n\nclass ReactNativeDelegate/,
      '\n  func open() { RCTLinkingManager.self }\n}\n\nclass ReactNativeDelegate',
    );
    expect(() => patchAppDelegate(changed)).toThrow(/already has linking overrides/);
  });
});

describe('withCarPlay: entitlement', () => {
  it('adds the CarPlay audio entitlement by default and leaves it out with AUDIOSILO_CARPLAY=0 (or false, off, no)', () => {
    const on = { [CARPLAY_ENTITLEMENT]: true };
    expect(applyCarPlayEntitlement({}, {})).toEqual(on);
    expect(applyCarPlayEntitlement({}, { AUDIOSILO_CARPLAY: '1' })).toEqual(on);
    expect(applyCarPlayEntitlement({}, { AUDIOSILO_CARPLAY: 'true' })).toEqual(on);
    expect(applyCarPlayEntitlement({}, { AUDIOSILO_CARPLAY: '0' })).toEqual({});
    // The other usual spellings of off opt out too.
    for (const off of ['false', 'FALSE', 'off', 'no', ' 0 ']) {
      expect(applyCarPlayEntitlement({}, { AUDIOSILO_CARPLAY: off })).toEqual({});
    }
  });

  it('removes a stale entitlement when opted out and keeps other keys', () => {
    const out = applyCarPlayEntitlement(
      { [CARPLAY_ENTITLEMENT]: true, 'aps-environment': 'development' },
      { AUDIOSILO_CARPLAY: '0' },
    );
    expect(out).toEqual({ 'aps-environment': 'development' });
  });
});
