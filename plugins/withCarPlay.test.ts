import {
  applyCarPlayEntitlement,
  applySceneManifest,
  CARPLAY_ENTITLEMENT,
  patchAppDelegate,
} from './withCarPlay';
import { APP_DELEGATE_SDK56 } from './__fixtures__/app-delegate-sdk56';

const template = APP_DELEGATE_SDK56;

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
  it('replaces the window creation with the stored scene starter', () => {
    const out = patchAppDelegate(template);
    expect(out).toContain('\ninternal import AudiosiloPlayer');
    expect(out).toContain('AudiosiloScenes.configure(');
    expect(out).toContain('mirrorWindow: { [weak self] window in self?.window = window }');
    expect(out).not.toContain('UIWindow(frame: UIScreen.main.bounds)');
    // The starter still starts "main", now with the scene's window and launch options.
    expect(out).toMatch(/withModuleName: "main",\s*in: window,\s*launchOptions: options\)/);
    // The factory is still created and kept by the app delegate; the linking overrides stay.
    expect(out).toContain('let factory = ExpoReactNativeFactory(delegate: delegate)');
    expect(out).toContain('RCTLinkingManager.application(app, open: url, options: options)');
    expect(out).toContain('return super.application(application, didFinishLaunchingWithOptions');
  });

  it('is idempotent', () => {
    const once = patchAppDelegate(template);
    expect(patchAppDelegate(once)).toBe(once);
  });

  it('fails loudly when the template window block changed', () => {
    const changed = template.replace(
      'window = UIWindow(frame: UIScreen.main.bounds)',
      'window = UIWindow(frame: .zero)',
    );
    expect(() => patchAppDelegate(changed)).toThrow(/does not match the Expo SDK 56 template/);
  });

  it('fails loudly when the linking overrides no longer call RCTLinkingManager', () => {
    const changed = template.replace(
      '|| RCTLinkingManager.application(app, open: url, options: options)',
      '',
    );
    expect(() => patchAppDelegate(changed)).toThrow(/RCTLinkingManager/);
  });
});

describe('withCarPlay: entitlement', () => {
  it('adds the CarPlay audio entitlement only with AUDIOSILO_CARPLAY=1', () => {
    expect(applyCarPlayEntitlement({}, { AUDIOSILO_CARPLAY: '1' })).toEqual({
      [CARPLAY_ENTITLEMENT]: true,
    });
    expect(applyCarPlayEntitlement({}, {})).toEqual({});
    expect(applyCarPlayEntitlement({}, { AUDIOSILO_CARPLAY: 'true' })).toEqual({});
  });

  it('removes a stale entitlement when the flag is off and keeps other keys', () => {
    const out = applyCarPlayEntitlement(
      { [CARPLAY_ENTITLEMENT]: true, 'aps-environment': 'development' },
      {},
    );
    expect(out).toEqual({ 'aps-environment': 'development' });
  });
});
