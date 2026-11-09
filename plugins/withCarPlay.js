const { withAppDelegate, withEntitlementsPlist, withInfoPlist } = require('expo/config-plugins');

/**
 * CarPlay: run the iOS app on the UIScene life cycle with our own scene delegates, and
 * declare a CarPlay scene.
 *
 * Expo SDK 58's template is already a scene app: its AppDelegate only builds the React
 * Native factory, and its `SceneDelegate` (an `ExpoAppSceneDelegate`) creates the window and
 * starts React Native. We keep our own delegates instead: a CarPlay-first launch must park
 * React Native in an off-screen window the phone scene adopts later, and Expo's delegate
 * always starts it itself. So this plugin does three things:
 *
 *  1. Info.plist: a scene manifest with a phone scene (`AudiosiloPhoneSceneDelegate`) and a
 *     CarPlay scene (`AudiosiloCarPlaySceneDelegate`, a `CPTemplateApplicationScene`),
 *     replacing the template's (whose `SceneDelegate.swift` stays in the project, unused).
 *     Both classes live in `modules/audiosilo-player/ios` with stable `@objc` names.
 *  2. AppDelegate.swift: a STORED starter (`AudiosiloScenes.configure`) right after the
 *     factory is made, which the first scene to connect runs: the phone scene into its own
 *     window, a CarPlay-first launch into an off-screen window that the phone scene adopts
 *     later. The template text is matched exactly; any other text fails the prebuild loudly (a
 *     silent miss would ship a black screen). No linking overrides: `ExpoAppDelegate`'s own
 *     methods hand a link to Expo's subscribers, and React Native 0.88's `RCTLinkingManager`
 *     ignores its app-delegate methods in a scene app, so the phone scene delegate hands each
 *     link to its scene API itself.
 *  3. Entitlements: `com.apple.developer.carplay-audio` by default (Apple granted it to the team on
 *     2026-10-09; both App IDs carry the capability). `AUDIOSILO_CARPLAY=0` at prebuild leaves it
 *     out, for a signing identity without the grant; without it iOS simply never connects a
 *     CarPlay scene (the scene code still ships).
 *
 * Plugin order: a plugin that rewrites the AppDelegate must NOT be listed after this one in
 * app.json. Mods of one kind run in REVERSE registration order, so a plugin listed after this
 * one would edit the template first and break the exact match above. (`expo-widgets`, listed
 * after it, edits Info.plist and the entitlements but not the AppDelegate.)
 *
 * The transforms are pure and exported for `withCarPlay.test.ts`.
 */

const PHONE_DELEGATE = 'AudiosiloPhoneSceneDelegate';
const CARPLAY_DELEGATE = 'AudiosiloCarPlaySceneDelegate';
const CARPLAY_ENTITLEMENT = 'com.apple.developer.carplay-audio';
const PATCHED_MARKER = 'AudiosiloScenes.configure(';

/** Info.plist: the scene manifest. `UIApplicationSupportsMultipleScenes` stays false: the
 * phone and CarPlay scenes are different roles, so they coexist without it (it is about
 * several phone/iPad windows, which the app does not support). */
function applySceneManifest(infoPlist) {
  return {
    ...infoPlist,
    UIApplicationSceneManifest: {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Phone',
            UISceneDelegateClassName: PHONE_DELEGATE,
          },
        ],
        CPTemplateApplicationSceneSessionRoleApplication: [
          {
            UISceneClassName: 'CPTemplateApplicationScene',
            UISceneConfigurationName: 'CarPlay',
            UISceneDelegateClassName: CARPLAY_DELEGATE,
          },
        ],
      },
    },
  };
}

// The SDK 58 template's anchors, each matched exactly (whitespace aside).
const TEMPLATE_IMPORT = /^import ReactAppDependencyProvider$/m;
const TEMPLATE_CLASS = /^class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider \{$/m;
const TEMPLATE_FACTORY = /^(\s*)reactNativeFactory = factory\n/m;
// The template's note that its SceneDelegate starts React Native: not true once patched.
const TEMPLATE_SCENE_NOTE =
  /^\s*\/\/ The window is created and React Native is started by `SceneDelegate`[^\n]*\n(\s*\/\/[^\n]*\n)?/m;

const STARTER = `
#if os(iOS) || os(tvOS)
    // withCarPlay: our own scene delegates (a phone scene and a CarPlay scene) run the app.
    // React Native starts in whichever scene connects first, with launch options rebuilt from
    // that scene's connection options, so nothing is shown from here.
    AudiosiloScenes.configure(
      start: { window, options in
        factory.startReactNative(
          withModuleName: "main",
          in: window,
          launchOptions: options)
      },
      mirrorWindow: { [weak self] window in self?.window = window }
    )
#endif
`;

function mismatch(what) {
  return new Error(
    `withCarPlay: AppDelegate.swift does not match the Expo SDK 58 template (${what}). ` +
      'The app would launch to a black screen under the scene life cycle. Update ' +
      'plugins/withCarPlay.js (and its fixture) for the new template before building.',
  );
}

/** AppDelegate.swift: add the stored scene starter right after the factory is made. */
function patchAppDelegate(contents) {
  if (contents.includes(PATCHED_MARKER)) return contents; // already patched (idempotent)
  if (!TEMPLATE_IMPORT.test(contents)) throw mismatch('no `import ReactAppDependencyProvider`');
  if (!TEMPLATE_CLASS.test(contents)) {
    throw mismatch('no `class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider`');
  }
  if (!TEMPLATE_FACTORY.test(contents)) throw mismatch('no `reactNativeFactory = factory`');
  return contents
    .replace(
      TEMPLATE_IMPORT,
      'import ReactAppDependencyProvider\n' +
        '// internal, like the generated ExpoModulesProvider.swift imports it (one access level per module).\n' +
        'internal import AudiosiloPlayer',
    )
    .replace(TEMPLATE_SCENE_NOTE, '')
    .replace(TEMPLATE_FACTORY, (line) => line + STARTER + '\n');
}

/** The values of `AUDIOSILO_CARPLAY` that leave the entitlement out (any case): `0` and the other
 * usual spellings of off, so an opt-out spelled `false` doesn't ship one a team can't sign. */
const CARPLAY_OFF = new Set(['0', 'false', 'off', 'no']);

/** Entitlements: the CarPlay audio entitlement, on unless `AUDIOSILO_CARPLAY=0`. Removed when
 * opted out so a non-clean prebuild cannot keep a stale one.
 * @param {Record<string, unknown>} entitlements
 * @param {Record<string, string | undefined>} [env]
 */
function applyCarPlayEntitlement(entitlements, env = process.env) {
  const next = { ...entitlements };
  const off = CARPLAY_OFF.has((env.AUDIOSILO_CARPLAY ?? '').trim().toLowerCase());
  if (!off) next[CARPLAY_ENTITLEMENT] = true;
  else delete next[CARPLAY_ENTITLEMENT];
  return next;
}

const withCarPlay = (config) => {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults = applySceneManifest(cfg.modResults);
    return cfg;
  });
  config = withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error('withCarPlay: expected a Swift AppDelegate (Expo SDK 58 template).');
    }
    cfg.modResults.contents = patchAppDelegate(cfg.modResults.contents);
    return cfg;
  });
  config = withEntitlementsPlist(config, (cfg) => {
    cfg.modResults = applyCarPlayEntitlement(cfg.modResults);
    return cfg;
  });
  return config;
};

module.exports = withCarPlay;
module.exports.applySceneManifest = applySceneManifest;
module.exports.patchAppDelegate = patchAppDelegate;
module.exports.applyCarPlayEntitlement = applyCarPlayEntitlement;
module.exports.CARPLAY_ENTITLEMENT = CARPLAY_ENTITLEMENT;
