const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');
const castPlugin = require('react-native-google-cast/app.plugin.js');

// The library's plugin is an ES module default export compiled to CommonJS.
const withGoogleCast = castPlugin.default ?? castPlugin;

/**
 * Chromecast: react-native-google-cast's own Expo config plugin, with the app's options, plus
 * the one thing it leaves out on Android.
 *
 *  - The Default Media Receiver (`CC1AD845`: no Cast registration, it plays the book's files
 *    as they are).
 *  - iOS: discovery starts on the first tap of the Cast button (so the local network prompt
 *    for Cast comes when the listener asks to cast, not at launch); the session is
 *    suspended in the background, because iOS suspends an app that plays no audio itself
 *    (the phone's engine is unloaded while casting, and a silent keep-alive would not pass
 *    App Review). The TV keeps playing; the app saves the place as it leaves and reads where
 *    the TV got to when it comes back (`src/cast/cast-session.ts`). No expanded controller:
 *    the app's own full player is the controller. The plugin writes `GCKCastContext.setSharedInstanceWith(...)` into
 *    `application(_:didFinishLaunchingWithOptions:)` before `let delegate =
 *    ReactNativeDelegate()` and `import GoogleCast` before `import React`, plus the Bonjour
 *    services; it keeps an `NSLocalNetworkUsageDescription` that is already there, and
 *    app.json's says what it is for (the server AND Cast devices).
 *  - Android: the Cast framework version is PINNED (the plugin's default is `+`, a build
 *    that changes under us). The library's options provider keeps the Cast SDK's own media
 *    notification and media session: while a book casts the app's Media3 engine is
 *    unloaded (`RoutedPlaybackService`), so those are the lock screen's and the
 *    notification shade's controls for the cast, and the notification's foreground service
 *    keeps the app alive so the place keeps being saved. The notification opens the
 *    library's expanded controller activity, which the plugin declares only with
 *    `expandedController` (that option also turns on iOS's automatic expanded controls,
 *    which we don't want), so it is declared here.
 *
 * Plugin order (app.json): listed BEFORE `./plugins/withCarPlay`. Mods of one kind run in
 * reverse registration order, so withCarPlay's exact match sees Expo's template untouched
 * and this plugin's AppDelegate edits land after it (`withCast.test.ts` runs both, in this
 * order, over the SDK 56 AppDelegate).
 */

/** play-services-cast-framework, pinned. */
const CAST_FRAMEWORK_VERSION = '22.3.1';
const EXPANDED_CONTROLLER = 'com.reactnative.googlecast.RNGCExpandedControllerActivity';

const CAST_OPTIONS = {
  receiverAppId: 'CC1AD845',
  iosStartDiscoveryAfterFirstTapOnCastButton: true,
  iosSuspendSessionsWhenBackgrounded: true,
  expandedController: false,
  androidPlayServicesCastFrameworkVersion: CAST_FRAMEWORK_VERSION,
};

/** AndroidManifest: declare the library's expanded controller activity once (not exported:
 * only the Cast notification inside this app opens it). */
function addExpandedController(manifest) {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  const activities = (app.activity ?? []).filter(
    (a) => a.$?.['android:name'] !== EXPANDED_CONTROLLER,
  );
  activities.push({ $: { 'android:name': EXPANDED_CONTROLLER, 'android:exported': 'false' } });
  app.activity = activities;
  return manifest;
}

const withCast = (config) => {
  config = withGoogleCast(config, CAST_OPTIONS);
  config = withAndroidManifest(config, (cfg) => {
    cfg.modResults = addExpandedController(cfg.modResults);
    return cfg;
  });
  return config;
};

module.exports = withCast;
module.exports.CAST_OPTIONS = CAST_OPTIONS;
module.exports.CAST_FRAMEWORK_VERSION = CAST_FRAMEWORK_VERSION;
module.exports.addExpandedController = addExpandedController;
