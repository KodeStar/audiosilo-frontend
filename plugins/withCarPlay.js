const { withAppDelegate, withEntitlementsPlist, withInfoPlist } = require('expo/config-plugins');

/**
 * CarPlay (Phase 6): move the iOS app onto the UIScene life cycle and declare a CarPlay scene.
 *
 * Declaring ANY scene in `UIApplicationSceneManifest` moves the whole app to the scene life
 * cycle, and from then on UIKit never shows a window the app delegate made. Expo SDK 56's
 * template still creates its window (and starts React Native into it) in
 * `application(_:didFinishLaunchingWithOptions:)`, so this plugin does three things:
 *
 *  1. Info.plist: a scene manifest with a phone scene (`AudiosiloPhoneSceneDelegate`) and a
 *     CarPlay scene (`AudiosiloCarPlaySceneDelegate`, a `CPTemplateApplicationScene`). Both
 *     classes live in `modules/audiosilo-player/ios` with stable `@objc` names.
 *  2. AppDelegate.swift: the template's window creation + `startReactNative` become a STORED
 *     starter (`AudiosiloScenes.configure`), which the first scene to connect runs: the phone
 *     scene into its own window, a CarPlay-first launch into an off-screen window that the
 *     phone scene adopts later. The template text is matched exactly; any other text fails the
 *     prebuild loudly (a silent miss would ship a black screen: a scene app whose React Native
 *     never starts in a scene window).
 *  3. Entitlements: `com.apple.developer.carplay-audio` ONLY with `AUDIOSILO_CARPLAY=1` at
 *     prebuild. A device build carrying it cannot be signed until Apple grants it; without it
 *     iOS simply never connects a CarPlay scene (the scene code still ships).
 *
 * List this plugin BEFORE `expo-widgets` in app.json and after nothing that rewrites the
 * AppDelegate: mods of one kind run in REVERSE registration order, so a plugin listed after
 * this one would edit the template before this plugin matches it.
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

// The SDK 56 template's window creation, whitespace-tolerant but otherwise exact.
const TEMPLATE_WINDOW = new RegExp(
  [
    String.raw`#if os\(iOS\) \|\| os\(tvOS\)\s*`,
    String.raw`window = UIWindow\(frame: UIScreen\.main\.bounds\)\s*`,
    String.raw`factory\.startReactNative\(\s*`,
    String.raw`withModuleName: "main",\s*`,
    String.raw`in: window,\s*`,
    String.raw`launchOptions: launchOptions\)\s*`,
    String.raw`#endif`,
  ].join(''),
);
const TEMPLATE_IMPORT = /^import ReactAppDependencyProvider$/m;
// The scene delegates forward URLs and user activities to these app-delegate overrides,
// relying on them to hand the link to React Native (RCTLinkingManager). Under the scene life
// cycle UIKit no longer calls them itself.
const TEMPLATE_LINKING = [
  /RCTLinkingManager\.application\(app, open: url, options: options\)/,
  /RCTLinkingManager\.application\(application, continue: userActivity, restorationHandler: restorationHandler\)/,
];

const STARTER = `#if os(iOS) || os(tvOS)
    // withCarPlay: the app runs on the UIScene life cycle (a phone scene and a CarPlay scene).
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
#endif`;

function mismatch(what) {
  return new Error(
    `withCarPlay: AppDelegate.swift does not match the Expo SDK 56 template (${what}). ` +
      'The app would launch to a black screen under the scene life cycle. Update ' +
      'plugins/withCarPlay.js (and its fixture) for the new template before building.',
  );
}

/** AppDelegate.swift: replace the template's window + start with the stored starter. */
function patchAppDelegate(contents) {
  if (contents.includes(PATCHED_MARKER)) return contents; // already patched (idempotent)
  if (!TEMPLATE_IMPORT.test(contents)) throw mismatch('no `import ReactAppDependencyProvider`');
  if (!TEMPLATE_WINDOW.test(contents)) throw mismatch('no window + startReactNative block');
  for (const re of TEMPLATE_LINKING) {
    if (!re.test(contents)) throw mismatch(`no ${re.source.replace(/\\/g, '')}`);
  }
  return contents
    .replace(TEMPLATE_IMPORT, 'import ReactAppDependencyProvider\nimport AudiosiloPlayer')
    .replace(TEMPLATE_WINDOW, STARTER);
}

/** Entitlements: the CarPlay audio entitlement, opt-in. Removed when the flag is off so a
 * non-clean prebuild cannot keep a stale one.
 * @param {Record<string, unknown>} entitlements
 * @param {Record<string, string | undefined>} [env]
 */
function applyCarPlayEntitlement(entitlements, env = process.env) {
  const next = { ...entitlements };
  if (env.AUDIOSILO_CARPLAY === '1') next[CARPLAY_ENTITLEMENT] = true;
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
      throw new Error('withCarPlay: expected a Swift AppDelegate (Expo SDK 56 template).');
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
